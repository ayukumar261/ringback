package session

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"time"

	"github.com/coder/websocket"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
	"github.com/ayukumar261/ringback/apps/worker/internal/elevenlabs"
)

const (
	maxDrain   = 30 * time.Second       // cap on goodbye playout after a clean agent end
	drainGrace = 100 * time.Millisecond // lets the final frames clear the wire
)

// roomHandle is the slice of room.Room the bridge needs.
type roomHandle interface {
	CallerPCM() <-chan []byte
	Enqueue(pcm []byte)
	Flush()
	Buffered() time.Duration
	Done() <-chan struct{}
	Err() error
	Close() error
}

// convHandle is the slice of elevenlabs.Conversation the bridge needs.
type convHandle interface {
	SendAudio(pcm []byte) error
	Events() <-chan elevenlabs.Event
	Err() error
	Close() error
}

// bridge pumps audio both ways and tears both sides down when either ends.
func bridge(ctx context.Context, rm roomHandle, conv convHandle, turns *turnLog, log *slog.Logger) error {
	// The room dying must unblock the event pump below.
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		<-rm.Done()
		conv.Close()
	}()

	// upErr is written before upExited closes and read only after it closes.
	var upErr error
	upExited := make(chan struct{})
	go func() {
		upErr = uplink(rm.CallerPCM(), conv.SendAudio)
		close(upExited)
		if upErr != nil {
			conv.Close()
		}
	}()

	clientErr := downlink(conv.Events(), rm, turns, log)
	if clientErr != nil {
		conv.Close()
	}
	convErr := conv.Err()

	drainOK := clientErr == nil && cleanConvEnd(convErr)
	select {
	case <-upExited:
		drainOK = drainOK && upErr == nil
	default:
	}
	if drainOK {
		drain(ctx, rm.Buffered, rm.Done(), maxDrain, log)
	}

	rm.Close()
	<-upExited
	<-watchDone
	conv.Close()
	return classify(clientErr, rm.Err(), convErr, upErr)
}

// uplink forwards caller frames to the agent until the room ends or a send truly fails.
func uplink(pcm <-chan []byte, send func([]byte) error) error {
	for frame := range pcm {
		if err := send(frame); err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
	}
	return nil
}

// downlink applies agent events to the room until the events close or a fatal server error.
func downlink(events <-chan elevenlabs.Event, rm roomHandle, turns *turnLog, log *slog.Logger) error {
	for ev := range events {
		switch e := ev.(type) {
		case elevenlabs.AudioEvent:
			rm.Enqueue(e.PCM)
		case elevenlabs.Interruption:
			rm.Flush()
			log.Info("caller barge-in", "event_id", e.EventID)
		case elevenlabs.UserTranscript:
			turns.caller(e.Text)
			log.Info("caller said", "text", e.Text)
		case elevenlabs.AgentResponse:
			turns.agent(e.Text)
			log.Info("agent said", "text", e.Text)
		case elevenlabs.AgentResponseCorrection:
			turns.correct(e.Corrected)
			log.Info("agent cut off", "corrected", e.Corrected)
		case elevenlabs.ClientError:
			return fmt.Errorf("session: agent error: %s: %s", e.ErrorName, e.Message)
		case elevenlabs.UnknownEvent:
			raw := e.Raw
			if len(raw) > 200 {
				raw = raw[:200]
			}
			log.Debug("unhandled agent event", "type", e.Type, "raw", string(raw))
		}
	}
	return nil
}

// drain waits for queued agent audio to finish playing, bounded by max and both end signals.
func drain(ctx context.Context, buffered func() time.Duration, done <-chan struct{}, max time.Duration, log *slog.Logger) {
	deadline := time.NewTimer(max)
	defer deadline.Stop()
	ticker := time.NewTicker(audio.FrameDuration)
	defer ticker.Stop()
	for buffered() > 0 {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-deadline.C:
			log.Info("dropping agent audio still queued at drain cap", "buffered", buffered())
			return
		case <-ticker.C:
		}
	}
	select {
	case <-ctx.Done():
	case <-done:
	case <-time.After(drainGrace):
	}
}

// cleanConvEnd reports whether the conversation ended without a transport failure.
func cleanConvEnd(err error) bool {
	return err == nil || websocket.CloseStatus(err) == websocket.StatusNormalClosure
}
