// Package room manages SFU rooms. Each room has a set of peers.
// When a peer produces a track, it gets forwarded to all other peers in the room.
package room

import (
	"fmt"
	"log/slog"
	"sync"

	"github.com/anukulrajan7/talktofriend/sfu/internal/peer"
	"github.com/pion/webrtc/v4"
)

// Room holds all peers and their tracks for a single call.
type Room struct {
	Code  string
	mu    sync.RWMutex
	peers map[string]*peer.Peer // socketID -> Peer
	log   *slog.Logger
}

// New creates an empty room.
func New(code string) *Room {
	return &Room{
		Code:  code,
		peers: make(map[string]*peer.Peer),
		log:   slog.With("module", "room", "room", code),
	}
}

// AddPeer creates a new peer with send+recv PeerConnections.
// Returns transport params the client needs for WebRTC negotiation.
func (r *Room) AddPeer(id string, api *webrtc.API, cfg webrtc.Configuration) (*peer.TransportParams, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, exists := r.peers[id]; exists {
		return nil, fmt.Errorf("peer %s already exists", id)
	}

	p, params, err := peer.New(id, api, cfg)
	if err != nil {
		return nil, fmt.Errorf("create peer: %w", err)
	}

	// When this peer produces a track, forward it to all other peers
	p.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		r.log.Info("track received", "peer", id, "kind", track.Kind(), "codec", track.Codec().MimeType)
		r.forwardTrack(id, track)
	})

	// Clean up when peer disconnects
	p.OnClose(func() {
		r.mu.Lock()
		delete(r.peers, id)
		r.mu.Unlock()
		r.log.Info("peer removed", "peer", id, "remaining", r.PeerCount())
	})

	r.peers[id] = p
	r.log.Info("peer added", "peer", id, "total", len(r.peers))

	return params, nil
}

// RemovePeer closes and removes a peer from the room.
func (r *Room) RemovePeer(id string) {
	r.mu.Lock()
	p, exists := r.peers[id]
	if exists {
		delete(r.peers, id)
	}
	r.mu.Unlock()

	if p != nil {
		p.Close()
	}
}

// forwardTrack takes a remote track from one peer and creates local tracks
// on all other peers to forward the media.
func (r *Room) forwardTrack(producerID string, remoteTrack *webrtc.TrackRemote) {
	// Create a local track that we'll write RTP to
	localTrack, err := webrtc.NewTrackLocalStaticRTP(
		remoteTrack.Codec().RTPCodecCapability,
		remoteTrack.ID(),
		remoteTrack.StreamID(),
	)
	if err != nil {
		r.log.Error("failed to create local track", "err", err)
		return
	}

	// Add this track to all OTHER peers
	r.mu.RLock()
	for pid, p := range r.peers {
		if pid == producerID {
			continue
		}
		if err := p.AddForwardedTrack(localTrack, producerID); err != nil {
			r.log.Error("failed to add track to peer", "peer", pid, "err", err)
		}
	}
	r.mu.RUnlock()

	// Read RTP from remote and write to local (forwarding loop)
	go func() {
		buf := make([]byte, 1500)
		for {
			n, _, err := remoteTrack.Read(buf)
			if err != nil {
				r.log.Debug("track read ended", "producer", producerID, "err", err)
				return
			}
			if _, err := localTrack.Write(buf[:n]); err != nil {
				r.log.Debug("track write ended", "producer", producerID, "err", err)
				return
			}
		}
	}()
}

// GetPeer returns a peer by ID, or nil if not found.
func (r *Room) GetPeer(id string) *peer.Peer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.peers[id]
}

// PeerCount returns the number of peers in the room.
func (r *Room) PeerCount() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.peers)
}

// IsEmpty returns true if the room has no peers.
func (r *Room) IsEmpty() bool {
	return r.PeerCount() == 0
}

// Close removes all peers and cleans up.
func (r *Room) Close() {
	r.mu.Lock()
	peers := make([]*peer.Peer, 0, len(r.peers))
	for _, p := range r.peers {
		peers = append(peers, p)
	}
	r.peers = make(map[string]*peer.Peer)
	r.mu.Unlock()

	for _, p := range peers {
		p.Close()
	}
	r.log.Info("room closed")
}
