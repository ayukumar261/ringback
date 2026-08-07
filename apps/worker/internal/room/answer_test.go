package room

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
)

const answerTestWait = 20 * time.Millisecond

func TestWaitForAnswerAnswered(t *testing.T) {
	answered := make(chan struct{})
	close(answered)
	if err := waitForAnswer(t.Context(), answered, nil, func() error { return nil }, answerTestWait); err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
}

func TestWaitForAnswerRoomEnded(t *testing.T) {
	done := make(chan struct{})
	close(done)
	err := waitForAnswer(t.Context(), nil, done, func() error { return nil }, answerTestWait)
	if !errors.Is(err, ErrNotAnswered) {
		t.Fatalf("err = %v, want ErrNotAnswered", err)
	}
}

func TestWaitForAnswerRoomError(t *testing.T) {
	boom := errors.New("boom")
	done := make(chan struct{})
	close(done)
	err := waitForAnswer(t.Context(), nil, done, func() error { return boom }, answerTestWait)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
	if errors.Is(err, ErrNotAnswered) {
		t.Fatalf("err = %v, must not wrap ErrNotAnswered", err)
	}
}

func TestWaitForAnswerTimeout(t *testing.T) {
	err := waitForAnswer(t.Context(), nil, nil, func() error { return nil }, answerTestWait)
	if !errors.Is(err, ErrNotAnswered) {
		t.Fatalf("err = %v, want ErrNotAnswered", err)
	}
}

func TestWaitForAnswerCtxCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := waitForAnswer(ctx, nil, nil, func() error { return nil }, time.Minute)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestOnAttributesChangedActive(t *testing.T) {
	r := &Room{answered: make(chan struct{}), log: discard}
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.onAttributesChanged(map[string]string{livekit.AttrSIPCallStatus: sipStatusActive}, nil)
		}()
	}
	wg.Wait()
	select {
	case <-r.answered:
	default:
		t.Fatal("answered still open after an active status")
	}
}

func TestOnAttributesChangedIgnoresOthers(t *testing.T) {
	r := &Room{answered: make(chan struct{}), log: discard}
	for _, changed := range []map[string]string{
		nil,
		{"speaking": "true"},
		{livekit.AttrSIPCallStatus: "call_incoming"},
		{livekit.AttrSIPCallStatus: "participant_joined"},
		{livekit.AttrSIPCallStatus: "disconnected"},
		{livekit.AttrSIPCallStatus: "error"},
		{livekit.AttrSIPCallStatus: ""},
	} {
		r.onAttributesChanged(changed, nil)
		select {
		case <-r.answered:
			t.Fatalf("answered closed after %v", changed)
		default:
		}
	}
}
