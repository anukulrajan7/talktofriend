// Package server provides the HTTP API that Node.js calls to manage SFU rooms.
package server

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/anukulrajan7/talktofriend/sfu/internal/room"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/webrtc/v4"
)

// Server is the SFU HTTP API server.
type Server struct {
	rooms  map[string]*room.Room
	mu     sync.RWMutex
	api    *webrtc.API
	cfg    webrtc.Configuration
	log    *slog.Logger
	start  time.Time

	// Metrics
	totalRooms  atomic.Int64
	totalPeers  atomic.Int64
	activeRooms atomic.Int64
	activePeers atomic.Int64
}

// New creates the SFU server with Pion WebRTC configured.
func New() (*Server, error) {
	// Configure media engine with codecs
	m := &webrtc.MediaEngine{}
	if err := m.RegisterDefaultCodecs(); err != nil {
		return nil, fmt.Errorf("register codecs: %w", err)
	}

	// Set up interceptors for NACK (retransmission) and RTCP reports
	i := &interceptor.Registry{}
	responder, err := nack.NewResponderInterceptor()
	if err != nil {
		return nil, fmt.Errorf("nack responder: %w", err)
	}
	i.Add(responder)

	generator, err := nack.NewGeneratorInterceptor()
	if err != nil {
		return nil, fmt.Errorf("nack generator: %w", err)
	}
	i.Add(generator)

	if err := webrtc.RegisterDefaultInterceptors(m, i); err != nil {
		return nil, fmt.Errorf("register interceptors: %w", err)
	}

	// ICE configuration
	se := webrtc.SettingEngine{}

	// Set port range for WebRTC
	minPort := envInt("RTC_MIN_PORT", 40000)
	maxPort := envInt("RTC_MAX_PORT", 40200)
	se.SetEphemeralUDPPortRange(uint16(minPort), uint16(maxPort))

	// Set announced IP if provided (required in production)
	if ip := os.Getenv("ANNOUNCED_IP"); ip != "" {
		se.SetNAT1To1IPs([]string{ip}, webrtc.ICECandidateTypeHost)
	}

	// Set network types
	se.SetNetworkTypes([]webrtc.NetworkType{
		webrtc.NetworkTypeUDP4,
		webrtc.NetworkTypeTCP4,
	})

	// Create the API
	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(m),
		webrtc.WithInterceptorRegistry(i),
		webrtc.WithSettingEngine(se),
	)

	// STUN servers for ICE
	cfg := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	}

	return &Server{
		rooms: make(map[string]*room.Room),
		api:   api,
		cfg:   cfg,
		log:   slog.With("module", "server"),
		start: time.Now(),
	}, nil
}

// Handler returns the HTTP handler with all routes.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /metrics", s.handleMetrics)

	// Room management
	mux.HandleFunc("POST /rooms/{code}", s.handleCreateRoom)
	mux.HandleFunc("DELETE /rooms/{code}", s.handleDeleteRoom)

	// Peer management
	mux.HandleFunc("POST /rooms/{code}/peers/{id}/join", s.handleJoinRoom)
	mux.HandleFunc("DELETE /rooms/{code}/peers/{id}", s.handleRemovePeer)

	// Signaling (SDP + ICE)
	mux.HandleFunc("POST /rooms/{code}/peers/{id}/offer", s.handleOffer)
	mux.HandleFunc("POST /rooms/{code}/peers/{id}/answer", s.handleAnswer)
	mux.HandleFunc("POST /rooms/{code}/peers/{id}/ice", s.handleICE)

	return mux
}

// ListenAndServe starts the HTTP server.
func (s *Server) ListenAndServe(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	s.log.Info("SFU server listening", "addr", addr)
	return http.Serve(ln, s.Handler())
}

// ── Handlers ─────────────────────────────────────────────────

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "service": "go-sfu"})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	activeRooms := len(s.rooms)
	activePeers := 0
	for _, rm := range s.rooms {
		activePeers += rm.PeerCount()
	}
	s.mu.RUnlock()

	lines := []string{
		promGauge("sfu_uptime_seconds", "SFU uptime", int(time.Since(s.start).Seconds())),
		promGauge("sfu_rooms_active", "Active SFU rooms", activeRooms),
		promGauge("sfu_peers_active", "Active SFU peers", activePeers),
		promCounter("sfu_rooms_total", "Total rooms created", int(s.totalRooms.Load())),
		promCounter("sfu_peers_total", "Total peers joined", int(s.totalPeers.Load())),
	}

	w.Header().Set("Content-Type", "text/plain")
	fmt.Fprint(w, strings.Join(lines, "\n")+"\n")
}

func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")

	s.mu.Lock()
	if _, exists := s.rooms[code]; exists {
		s.mu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true, "existed": true})
		return
	}
	rm := room.New(code)
	s.rooms[code] = rm
	s.mu.Unlock()

	s.totalRooms.Add(1)
	s.log.Info("room created", "room", code)
	writeJSON(w, 201, map[string]any{"ok": true, "code": code})
}

func (s *Server) handleDeleteRoom(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")

	s.mu.Lock()
	rm, exists := s.rooms[code]
	if exists {
		delete(s.rooms, code)
	}
	s.mu.Unlock()

	if rm != nil {
		rm.Close()
	}

	s.log.Info("room deleted", "room", code)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	peerID := r.PathValue("id")

	s.mu.RLock()
	rm, exists := s.rooms[code]
	s.mu.RUnlock()

	if !exists {
		writeJSON(w, 404, map[string]any{"error": "room not found"})
		return
	}

	params, err := rm.AddPeer(peerID, s.api, s.cfg)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}

	s.totalPeers.Add(1)
	_ = params // Will be used when we add full SDP exchange
	writeJSON(w, 200, map[string]any{"ok": true, "peer": peerID})
}

func (s *Server) handleRemovePeer(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	peerID := r.PathValue("id")

	s.mu.RLock()
	rm, exists := s.rooms[code]
	s.mu.RUnlock()

	if !exists {
		writeJSON(w, 404, map[string]any{"error": "room not found"})
		return
	}

	rm.RemovePeer(peerID)

	// Auto-cleanup empty rooms
	if rm.IsEmpty() {
		s.mu.Lock()
		delete(s.rooms, code)
		s.mu.Unlock()
		rm.Close()
		s.log.Info("room auto-cleaned (empty)", "room", code)
	}

	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleOffer(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	peerID := r.PathValue("id")

	var body struct {
		SDP  string `json:"sdp"`
		Type string `json:"type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]any{"error": "invalid JSON"})
		return
	}

	s.mu.RLock()
	rm, exists := s.rooms[code]
	s.mu.RUnlock()
	if !exists {
		writeJSON(w, 404, map[string]any{"error": "room not found"})
		return
	}

	// Get the peer
	_ = rm
	_ = peerID

	// For now, this is a placeholder — full SDP exchange will be wired
	// when we integrate with Node.js signaling
	writeJSON(w, 200, map[string]any{"ok": true, "status": "placeholder"})
}

func (s *Server) handleAnswer(w http.ResponseWriter, r *http.Request) {
	// Placeholder — will receive SDP answer from client via Node.js
	writeJSON(w, 200, map[string]any{"ok": true, "status": "placeholder"})
}

func (s *Server) handleICE(w http.ResponseWriter, r *http.Request) {
	// Placeholder — will receive ICE candidates from client via Node.js
	writeJSON(w, 200, map[string]any{"ok": true, "status": "placeholder"})
}

// ── Helpers ──────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func promGauge(name, help string, val int) string {
	return fmt.Sprintf("# HELP %s %s\n# TYPE %s gauge\n%s %d", name, help, name, name, val)
}

func promCounter(name, help string, val int) string {
	return fmt.Sprintf("# HELP %s %s\n# TYPE %s counter\n%s %d", name, help, name, name, val)
}
