package session

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"time"

	"github.com/coder/websocket"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
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
	SendDTMF(digits string) error
	Buffered() time.Duration
	Done() <-chan struct{}
	Err() error
	Close() error
}

// clock waits out a span and is swapped for a fake in tests.
type clock func(time.Duration) <-chan time.Time

// bridge pumps audio both ways and tears both sides down when either ends.
func bridge(ctx context.Context, rm roomHandle, conv agent.Conversation, turns *turnLog, after clock, log *slog.Logger) error {
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

	clientErr := downlink(conv, rm, turns, after, log)
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
func downlink(conv agent.Conversation, rm roomHandle, turns *turnLog, after clock, log *slog.Logger) error {
	for ev := range conv.Events() {
		switch e := ev.(type) {
		case agent.Audio:
			rm.Enqueue(e.PCM)
		case agent.Interruption:
			rm.Flush()
			log.Info("caller barge-in", "event_id", e.EventID)
		case agent.UserTurn:
			turns.caller(e.Text)
			log.Info("caller said", "text", e.Text)
		case agent.AgentTurn:
			turns.agent(e.Text)
			log.Info("agent said", "text", e.Text)
		case agent.Correction:
			turns.correct(e.Corrected)
			log.Info("agent cut off", "corrected", e.Corrected)
		case agent.Tool:
			if err := answerTool(conv, rm, e, after, log); err != nil {
				return err
			}
		case agent.Error:
			return fmt.Errorf("session: agent error: %s: %s", e.Name, e.Message)
		case agent.Unknown:
			raw := e.Raw
			if len(raw) > 200 {
				raw = raw[:200]
			}
			log.Debug("unhandled agent event", "type", e.Type, "raw", string(raw))
		}
	}
	return nil
}

// answerTool runs one tool call and replies once its tones have played, treating a closed conversation as benign.
func answerTool(conv agent.Conversation, rm roomHandle, call agent.Tool, after clock, log *slog.Logger) error {
	result, hold, err := runTool(rm, call)
	if err != nil {
		log.Warn("tool failed", "tool", call.Name, "err", err)
		err = conv.SendTool(call.ID, err.Error(), true)
	} else {
		log.Info("tool ran", "tool", call.Name, "result", result, "hold", hold)
		// Answering early would let the agent talk over the tones still on the wire.
		if hold > 0 {
			select {
			case <-after(hold):
			case <-rm.Done():
			}
		}
		err = conv.SendTool(call.ID, result, false)
	}
	if err != nil && !errors.Is(err, net.ErrClosed) {
		return fmt.Errorf("session: tool result: %w", err)
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
