// Package room bridges one LiveKit room to raw 48 kHz mono PCM.
package room

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

const (
	defaultIdentity = "ringback-worker"
	connectTimeout  = 10 * time.Second
	callerPCMBuffer = 50 // ~1 s of 20 ms frames
)

// Opts configures one room connection.
type Opts struct {
	URL       string
	APIKey    string
	APISecret string
	RoomName  string
	Identity  string // empty means ringback-worker
	Log       *slog.Logger
}

// Room is one live call's LiveKit connection.
type Room struct {
	log       *slog.Logger
	room      *lksdk.Room
	track     *lksdk.LocalTrack
	enc       *audio.Encoder
	dec       *audio.Decoder
	buf       *audio.PlayoutBuffer
	callerPCM chan []byte
	done      chan struct{}
	answered  chan struct{}
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup

	mu          sync.Mutex
	ended       bool
	err         error
	claimed     bool
	answeredSet bool
	rtrack      *webrtc.TrackRemote
}

// Join connects to one room, publishes the agent track, and starts bridging audio.
func Join(ctx context.Context, opts Opts) (*Room, error) {
	if opts.URL == "" || opts.APIKey == "" || opts.APISecret == "" || opts.RoomName == "" {
		return nil, fmt.Errorf("room: opts need URL, APIKey, APISecret, and RoomName")
	}
	identity := opts.Identity
	if identity == "" {
		identity = defaultIdentity
	}
	log := opts.Log
	if log == nil {
		log = slog.Default()
	}

	enc, err := audio.NewEncoder()
	if err != nil {
		return nil, err
	}
	dec, err := audio.NewDecoder()
	if err != nil {
		return nil, err
	}

	rctx, cancel := context.WithCancel(ctx)
	r := &Room{
		log:       log,
		enc:       enc,
		dec:       dec,
		buf:       audio.NewPlayoutBuffer(),
		callerPCM: make(chan []byte, callerPCMBuffer),
		done:      make(chan struct{}),
		answered:  make(chan struct{}),
		ctx:       rctx,
		cancel:    cancel,
	}

	cb := &lksdk.RoomCallback{
		OnDisconnectedWithReason:  r.onDisconnected,
		OnParticipantDisconnected: r.onParticipantDisconnected,
		OnReconnecting:            func() { log.Info("room reconnecting") },
		OnReconnected:             func() { log.Info("room reconnected") },
		ParticipantCallback: lksdk.ParticipantCallback{
			OnTrackSubscribed:   r.onTrackSubscribed,
			OnAttributesChanged: r.onAttributesChanged,
		},
	}
	lkroom, err := lksdk.ConnectToRoom(opts.URL, lksdk.ConnectInfo{
		APIKey:              opts.APIKey,
		APISecret:           opts.APISecret,
		RoomName:            opts.RoomName,
		ParticipantIdentity: identity,
	}, cb, lksdk.WithConnectTimeout(connectTimeout))
	if err != nil {
		cancel()
		return nil, fmt.Errorf("room: connect: %w", err)
	}
	r.room = lkroom
	go r.closer()

	track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus})
	if err != nil {
		return nil, r.fail(fmt.Errorf("room: create agent track: %w", err))
	}
	r.track = track
	if _, err := lkroom.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:   "agent",
		Source: livekit.TrackSource_MICROPHONE,
	}); err != nil {
		return nil, r.fail(fmt.Errorf("room: publish agent track: %w", err))
	}

	r.mu.Lock()
	if r.ended {
		r.mu.Unlock()
		<-r.done
		if err := r.Err(); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("room: closed during join")
	}
	r.wg.Add(1)
	r.mu.Unlock()
	go r.paceLoop()

	return r, nil
}

// Delete removes opts.RoomName server-side, hanging up anyone still in it.
func Delete(ctx context.Context, opts Opts) error {
	if opts.URL == "" || opts.APIKey == "" || opts.APISecret == "" || opts.RoomName == "" {
		return fmt.Errorf("room: opts need URL, APIKey, APISecret, and RoomName")
	}
	client := lksdk.NewRoomServiceClient(opts.URL, opts.APIKey, opts.APISecret)
	if _, err := client.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: opts.RoomName}); err != nil {
		return fmt.Errorf("room: delete: %w", err)
	}
	return nil
}

// CallerPCM returns decoded caller audio; it closes once the room is torn down.
func (r *Room) CallerPCM() <-chan []byte { return r.callerPCM }

// Caller reports the SIP participant's caller and dialed numbers, empty until one is visible.
func (r *Room) Caller() (from, to string) {
	for _, rp := range r.room.GetRemoteParticipants() {
		attrs := rp.Attributes()
		if attrs[livekit.AttrSIPCallID] == "" {
			continue
		}
		return attrs[livekit.AttrSIPPhoneNumber], attrs[livekit.AttrSIPTrunkNumber]
	}
	return "", ""
}

// Enqueue queues agent PCM for paced playout to the caller.
func (r *Room) Enqueue(pcm []byte) {
	if r.ctx.Err() != nil {
		return
	}
	r.buf.Push(pcm)
}

// Flush drops all queued agent audio on a barge-in.
func (r *Room) Flush() { r.buf.Flush() }

// Buffered reports how much queued agent audio has not yet played out.
func (r *Room) Buffered() time.Duration { return r.buf.Buffered() }

// Done closes when teardown finishes and Err is final.
func (r *Room) Done() <-chan struct{} { return r.done }

// Err reports why the room ended.
func (r *Room) Err() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.err
}

// Close ends the room and waits for teardown to finish.
func (r *Room) Close() error {
	r.terminate(nil)
	<-r.done
	return nil
}

// fail ends a partly joined room and hands back the join error.
func (r *Room) fail(err error) error {
	r.terminate(err)
	<-r.done
	return err
}

// terminate ends the room and keeps the first ending error.
func (r *Room) terminate(err error) {
	r.mu.Lock()
	if !r.ended {
		r.ended = true
		r.err = err
	}
	r.mu.Unlock()
	r.cancel()
}

// closer runs all blocking teardown once the room's context ends.
func (r *Room) closer() {
	<-r.ctx.Done()
	r.terminate(context.Cause(r.ctx))
	r.mu.Lock()
	rt := r.rtrack
	r.mu.Unlock()
	if rt != nil {
		rt.SetReadDeadline(time.Now())
	}
	r.room.Disconnect()
	r.wg.Wait()
	close(r.callerPCM)
	close(r.done)
}

// onTrackSubscribed claims the first remote audio track as the caller.
func (r *Room) onTrackSubscribed(track *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
	if track.Kind() != webrtc.RTPCodecTypeAudio {
		return
	}
	r.mu.Lock()
	if r.ended || r.claimed {
		r.mu.Unlock()
		r.log.Info("ignoring extra audio track", "identity", rp.Identity(), "participant_kind", int(rp.Kind()))
		return
	}
	r.claimed = true
	r.rtrack = track
	r.wg.Add(1)
	r.mu.Unlock()
	r.log.Info("caller track claimed", "identity", rp.Identity(), "participant_kind", int(rp.Kind()), "codec", track.Codec().MimeType)
	go r.readLoop(track)
}

// onParticipantDisconnected treats the caller leaving as the end of the call.
func (r *Room) onParticipantDisconnected(rp *lksdk.RemoteParticipant) {
	r.log.Info("participant disconnected", "identity", rp.Identity())
	r.terminate(nil)
}

// onDisconnected maps a server-side disconnect to the room's ending error.
func (r *Room) onDisconnected(reason lksdk.DisconnectionReason) {
	switch reason {
	case lksdk.LeaveRequested, lksdk.RoomClosed:
		r.terminate(nil)
	default:
		r.terminate(fmt.Errorf("room: disconnected: %s", reason))
	}
}
