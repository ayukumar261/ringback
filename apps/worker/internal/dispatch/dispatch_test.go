package dispatch

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	lkwebhook "github.com/livekit/protocol/webhook"

	"github.com/ayukumar261/ringback/apps/worker/internal/events"
	"github.com/ayukumar261/ringback/apps/worker/internal/session"
)

const waitFor = 2 * time.Second

// event builds one webhook event for room.
func event(kind, room string) *livekit.WebhookEvent {
	return &livekit.WebhookEvent{Event: kind, Room: &livekit.Room{Name: room}}
}

// activeCount reads how many sessions the dispatcher tracks.
func activeCount(d *Dispatcher) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.active)
}

// waitRecv fails the test if ch stays silent too long.
func waitRecv[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(waitFor):
		t.Fatalf("timed out waiting for %s", what)
		panic("unreachable")
	}
}

// waitEmpty fails the test if the dispatcher never returns to zero live sessions.
func waitEmpty(t *testing.T, d *Dispatcher) {
	t.Helper()
	deadline := time.Now().Add(waitFor)
	for activeCount(d) != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("dispatcher still tracks %d sessions", activeCount(d))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// nopDelete stands in for room deletion in tests that don't assert on it.
func nopDelete(context.Context, string) error { return nil }

// blockingRun records each invocation and blocks until its ctx ends.
type blockingRun struct {
	calls   atomic.Int32
	started chan string
	ended   chan struct{}
}

func newBlockingRun() *blockingRun {
	return &blockingRun{started: make(chan string, 8), ended: make(chan struct{}, 8)}
}

func (b *blockingRun) run(ctx context.Context, roomName string, _ session.Opts) error {
	b.calls.Add(1)
	b.started <- roomName
	<-ctx.Done()
	b.ended <- struct{}{}
	return nil
}

func TestStartsSessionForCallRoom(t *testing.T) {
	b := newBlockingRun()
	d := New(session.Opts{}, Config{Run: b.run, Delete: nopDelete})

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-abc"))
	if room := waitRecv(t, b.started, "session start"); room != "call-abc" {
		t.Fatalf("session ran for room %q", room)
	}
	if got := activeCount(d); got != 1 {
		t.Fatalf("tracking %d sessions, want 1", got)
	}

	d.HandleEvent(event(lkwebhook.EventRoomFinished, "call-abc"))
	waitRecv(t, b.ended, "cancellation after room_finished")
	waitEmpty(t, d)
}

func TestStampsInboundDirection(t *testing.T) {
	got := make(chan session.Opts, 1)
	d := New(session.Opts{}, Config{
		Run: func(_ context.Context, _ string, opts session.Opts) error {
			got <- opts
			return nil
		},
		Delete: nopDelete,
	})

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-abc"))
	if opts := waitRecv(t, got, "session opts"); opts.Direction != events.DirectionInbound {
		t.Fatalf("direction = %q, want %q", opts.Direction, events.DirectionInbound)
	}
	waitEmpty(t, d)
}

func TestIgnoresOtherRoomsAndEvents(t *testing.T) {
	b := newBlockingRun()
	d := New(session.Opts{}, Config{Run: b.run, Delete: nopDelete})

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "lobby"))
	d.HandleEvent(event(lkwebhook.EventParticipantJoined, "call-abc"))
	d.HandleEvent(event(lkwebhook.EventRoomFinished, "call-unknown"))
	d.HandleEvent(&livekit.WebhookEvent{Event: lkwebhook.EventRoomStarted})

	if got := activeCount(d); got != 0 {
		t.Fatalf("dispatched %d sessions for ignorable events", got)
	}
	if got := b.calls.Load(); got != 0 {
		t.Fatalf("run invoked %d times", got)
	}
}

func TestDuplicateStartRunsOnce(t *testing.T) {
	b := newBlockingRun()
	d := New(session.Opts{}, Config{Run: b.run, Delete: nopDelete})

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-abc"))
	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-abc"))

	waitRecv(t, b.started, "session start")
	if got := b.calls.Load(); got != 1 {
		t.Fatalf("run invoked %d times, want 1", got)
	}
	if got := activeCount(d); got != 1 {
		t.Fatalf("tracking %d sessions, want 1", got)
	}
}

func TestRoomCanRunAgainAfterSessionEnds(t *testing.T) {
	b := newBlockingRun()
	d := New(session.Opts{}, Config{Run: b.run, Delete: nopDelete})

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-abc"))
	waitRecv(t, b.started, "first session start")
	d.HandleEvent(event(lkwebhook.EventRoomFinished, "call-abc"))
	waitRecv(t, b.ended, "first session end")
	waitEmpty(t, d)

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-abc"))
	waitRecv(t, b.started, "second session start")
	if got := b.calls.Load(); got != 2 {
		t.Fatalf("run invoked %d times, want 2", got)
	}
}

func TestFailedSessionFreesTheRoom(t *testing.T) {
	ran := make(chan struct{}, 2)
	d := New(session.Opts{}, Config{
		Run: func(context.Context, string, session.Opts) error {
			ran <- struct{}{}
			return fmt.Errorf("boom")
		},
		Delete: nopDelete,
	})

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-abc"))
	waitRecv(t, ran, "first run")
	waitEmpty(t, d)

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-abc"))
	waitRecv(t, ran, "run after a failure")
}

func TestMaxCallCancelsStuckSession(t *testing.T) {
	b := newBlockingRun()
	d := New(session.Opts{}, Config{Run: b.run, MaxCall: 25 * time.Millisecond, Delete: nopDelete})

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-abc"))
	waitRecv(t, b.started, "session start")
	waitRecv(t, b.ended, "max-call cancellation")
	waitEmpty(t, d)
}

func TestDeletesRoomAfterSessionEnds(t *testing.T) {
	b := newBlockingRun()
	deleted := make(chan string, 2)
	d := New(session.Opts{}, Config{
		Run:    b.run,
		Delete: func(_ context.Context, roomName string) error { deleted <- roomName; return nil },
	})

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-abc"))
	waitRecv(t, b.started, "session start")
	d.HandleEvent(event(lkwebhook.EventRoomFinished, "call-abc"))
	waitRecv(t, b.ended, "session end")
	if room := waitRecv(t, deleted, "room deletion"); room != "call-abc" {
		t.Fatalf("deleted room %q, want call-abc", room)
	}
}

func TestFailedDeleteStillFreesTheRoom(t *testing.T) {
	ran := make(chan struct{}, 2)
	d := New(session.Opts{}, Config{
		Run: func(context.Context, string, session.Opts) error {
			ran <- struct{}{}
			return nil
		},
		Delete: func(context.Context, string) error { return fmt.Errorf("boom") },
	})

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-abc"))
	waitRecv(t, ran, "first run")
	waitEmpty(t, d)

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-abc"))
	waitRecv(t, ran, "run after a failed delete")
}

func TestDrainCancelsEverySession(t *testing.T) {
	b := newBlockingRun()
	d := New(session.Opts{}, Config{Run: b.run, Delete: nopDelete})

	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-a"))
	d.HandleEvent(event(lkwebhook.EventRoomStarted, "call-b"))
	waitRecv(t, b.started, "first session start")
	waitRecv(t, b.started, "second session start")

	ctx, cancel := context.WithTimeout(context.Background(), waitFor)
	defer cancel()
	d.Drain(ctx)

	waitRecv(t, b.ended, "first session end")
	waitRecv(t, b.ended, "second session end")
	if got := activeCount(d); got != 0 {
		t.Fatalf("tracking %d sessions after drain", got)
	}
}
