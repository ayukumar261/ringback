package room

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

const (
	answerTimeout   = 60 * time.Second
	sipStatusActive = "active" // livekit.AttrSIPCallStatus value; the protocol package exports no constant for it
)

// ErrNotAnswered reports a call that ended or timed out before the SIP participant went active.
var ErrNotAnswered = errors.New("room: not answered")

// WaitForAnswer blocks until the SIP participant's call goes active, the room ends, or answerTimeout passes.
func (r *Room) WaitForAnswer(ctx context.Context) error {
	for _, rp := range r.room.GetRemoteParticipants() {
		if rp.Attributes()[livekit.AttrSIPCallStatus] == sipStatusActive {
			return nil
		}
	}
	return waitForAnswer(ctx, r.answered, r.done, r.Err, answerTimeout)
}

// waitForAnswer waits for answered to close, failing when done closes, ctx ends, or timeout passes.
func waitForAnswer(ctx context.Context, answered, done <-chan struct{}, roomErr func() error, timeout time.Duration) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-answered:
		return nil
	case <-done:
		if err := roomErr(); err != nil {
			return err
		}
		return fmt.Errorf("%w: room ended", ErrNotAnswered)
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return fmt.Errorf("%w: timeout after %s", ErrNotAnswered, timeout)
	}
}

// onAttributesChanged watches SIP call status changes for the answer gate.
func (r *Room) onAttributesChanged(changed map[string]string, _ lksdk.Participant) {
	status := changed[livekit.AttrSIPCallStatus]
	if status == "" {
		return
	}
	r.log.Info("sip call status changed", "status", status)
	if status == sipStatusActive {
		r.markAnswered()
	}
}

// markAnswered unblocks WaitForAnswer, at most once.
func (r *Room) markAnswered() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.answeredSet {
		r.answeredSet = true
		close(r.answered)
	}
}
