// Package peer manages a single participant's WebRTC connection in the SFU.
// Each peer has one PeerConnection that handles both sending and receiving.
package peer

import (
	"fmt"
	"log/slog"
	"sync"

	"github.com/pion/webrtc/v4"
)

// TransportParams are returned to the client for WebRTC negotiation.
type TransportParams struct {
	// The SDP offer from the SFU's PeerConnection
	// Client creates an answer from this
}

// Peer represents one participant in an SFU room.
type Peer struct {
	ID string
	PC *webrtc.PeerConnection

	mu            sync.Mutex
	senders       map[string]*webrtc.RTPSender // trackID -> sender
	onTrackFunc   func(*webrtc.TrackRemote, *webrtc.RTPReceiver)
	onCloseFunc   func()
	closed        bool
	log           *slog.Logger
}

// New creates a peer with a PeerConnection configured for SFU use.
func New(id string, api *webrtc.API, cfg webrtc.Configuration) (*Peer, *TransportParams, error) {
	pc, err := api.NewPeerConnection(cfg)
	if err != nil {
		return nil, nil, fmt.Errorf("new peer connection: %w", err)
	}

	p := &Peer{
		ID:      id,
		PC:      pc,
		senders: make(map[string]*webrtc.RTPSender),
		log:     slog.With("module", "peer", "peer", id),
	}

	// Add transceivers for receiving audio and video from the client
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		pc.Close()
		return nil, nil, fmt.Errorf("add audio transceiver: %w", err)
	}
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{
		Direction: webrtc.RTPTransceiverDirectionRecvonly,
	}); err != nil {
		pc.Close()
		return nil, nil, fmt.Errorf("add video transceiver: %w", err)
	}

	// Wire up the OnTrack handler
	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		p.mu.Lock()
		fn := p.onTrackFunc
		p.mu.Unlock()
		if fn != nil {
			fn(track, receiver)
		}
	})

	// Monitor connection state
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		p.log.Info("ICE state changed", "state", state.String())
		if state == webrtc.ICEConnectionStateFailed || state == webrtc.ICEConnectionStateDisconnected {
			p.Close()
		}
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		p.log.Info("connection state changed", "state", state.String())
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			p.Close()
		}
	})

	return p, &TransportParams{}, nil
}

// OnTrack sets the callback for when this peer sends a media track.
func (p *Peer) OnTrack(fn func(*webrtc.TrackRemote, *webrtc.RTPReceiver)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.onTrackFunc = fn
}

// OnClose sets the callback for when this peer disconnects.
func (p *Peer) OnClose(fn func()) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.onCloseFunc = fn
}

// AddForwardedTrack adds a track from another peer to this peer's PeerConnection.
func (p *Peer) AddForwardedTrack(track *webrtc.TrackLocalStaticRTP, producerID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.closed {
		return fmt.Errorf("peer is closed")
	}

	sender, err := p.PC.AddTrack(track)
	if err != nil {
		return fmt.Errorf("add track: %w", err)
	}

	key := producerID + ":" + track.ID()
	p.senders[key] = sender

	// Read RTCP from receiver (handles NACK, PLI, etc)
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()

	p.log.Info("forwarded track added", "from", producerID, "track", track.ID())
	return nil
}

// SetRemoteDescription sets the client's SDP answer on this peer.
func (p *Peer) SetRemoteDescription(sdp webrtc.SessionDescription) error {
	return p.PC.SetRemoteDescription(sdp)
}

// CreateOffer creates an SDP offer for the client.
func (p *Peer) CreateOffer() (webrtc.SessionDescription, error) {
	offer, err := p.PC.CreateOffer(nil)
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	if err := p.PC.SetLocalDescription(offer); err != nil {
		return webrtc.SessionDescription{}, err
	}
	return offer, nil
}

// CreateAnswer creates an SDP answer after setting the client's offer.
func (p *Peer) CreateAnswer(offer webrtc.SessionDescription) (webrtc.SessionDescription, error) {
	if err := p.PC.SetRemoteDescription(offer); err != nil {
		return webrtc.SessionDescription{}, fmt.Errorf("set remote desc: %w", err)
	}
	answer, err := p.PC.CreateAnswer(nil)
	if err != nil {
		return webrtc.SessionDescription{}, fmt.Errorf("create answer: %w", err)
	}
	if err := p.PC.SetLocalDescription(answer); err != nil {
		return webrtc.SessionDescription{}, fmt.Errorf("set local desc: %w", err)
	}
	return answer, nil
}

// AddICECandidate adds a remote ICE candidate.
func (p *Peer) AddICECandidate(candidate webrtc.ICECandidateInit) error {
	return p.PC.AddICECandidate(candidate)
}

// Close shuts down the peer connection.
func (p *Peer) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	fn := p.onCloseFunc
	p.mu.Unlock()

	p.PC.Close()
	p.log.Info("peer closed")

	if fn != nil {
		fn()
	}
}
