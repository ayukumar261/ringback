package session

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ayukumar261/ringback/apps/worker/internal/elevenlabs"
)

// discard is a logger for paths whose output the tests do not assert on.
var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

// fakeRoom is a scriptable roomHandle that records operations in order.
type fakeRoom struct {
	pcm  chan []byte
	done chan struct{}

	mu       sync.Mutex
	err      error
	ops      []string
	buffered []time.Duration
	bufCalls int
	closed   bool
}

func newFakeRoom() *fakeRoom {
	return &fakeRoom{pcm: make(chan []byte, 8), done: make(chan struct{})}
}

func (f *fakeRoom) CallerPCM() <-chan []byte { return f.pcm }

func (f *fakeRoom) Enqueue(pcm []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, "enqueue:"+string(pcm))
}

func (f *fakeRoom) Flush() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ops = append(f.ops, "flush")
}

// Buffered pops the script one value per call and then repeats the last one.
func (f *fakeRoom) Buffered() time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bufCalls++
	if len(f.buffered) == 0 {
		return 0
	}
	d := f.buffered[0]
	if len(f.buffered) > 1 {
		f.buffered = f.buffered[1:]
	}
	return d
}

func (f *fakeRoom) Done() <-chan struct{} { return f.done }

func (f *fakeRoom) Err() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.err
}

func (f *fakeRoom) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		f.ops = append(f.ops, "close")
		close(f.done)
		close(f.pcm)
	}
	return nil
}

// kill simulates the room ending on its own with err.
func (f *fakeRoom) kill(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		f.err = err
		close(f.done)
		close(f.pcm)
	}
}

// snapshot copies the recorded operations and the drain call count.
func (f *fakeRoom) snapshot() ([]string, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.ops), f.bufCalls
}

// fakeConv is a scriptable convHandle that records sent frames.
type fakeConv struct {
	events chan elevenlabs.Event

	mu       sync.Mutex
	err      error
	sends    [][]byte
	sendErrs map[int]error
	closed   bool
}

func newFakeConv() *fakeConv {
	return &fakeConv{events: make(chan elevenlabs.Event, 16)}
}

func (f *fakeConv) SendAudio(pcm []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return net.ErrClosed
	}
	i := len(f.sends)
	f.sends = append(f.sends, bytes.Clone(pcm))
	return f.sendErrs[i]
}

func (f *fakeConv) Events() <-chan elevenlabs.Event { return f.events }

func (f *fakeConv) Err() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.err
}

func (f *fakeConv) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		close(f.events)
	}
	return nil
}

// finish simulates the server ending the conversation with err.
func (f *fakeConv) finish(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		f.err = err
		close(f.events)
	}
}

func (f *fakeConv) sent() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.sends)
}

func (f *fakeConv) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

// runBridge runs bridge under a liveness timeout and returns its error.
func runBridge(t *testing.T, ctx context.Context, rm *fakeRoom, conv *fakeConv) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- bridge(ctx, rm, conv, discard) }()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not return")
		return nil
	}
}

// waitFor polls cond until it holds or the deadline passes.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition never held")
}

func TestBridgeForwardsCallerAudio(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	frames := [][]byte{[]byte("a"), []byte("b"), []byte("c")}
	for _, fr := range frames {
		rm.pcm <- fr
	}
	done := make(chan error, 1)
	go func() { done <- bridge(context.Background(), rm, conv, discard) }()
	waitFor(t, func() bool { return len(conv.sent()) == len(frames) })
	rm.kill(nil)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("bridge = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not return")
	}
	got := conv.sent()
	for i, fr := range frames {
		if !bytes.Equal(got[i], fr) {
			t.Fatalf("send %d = %q, want %q", i, got[i], fr)
		}
	}
}

func TestBridgeEnqueueFlushOrder(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	conv.events <- elevenlabs.AudioEvent{PCM: []byte("a"), EventID: 1}
	conv.events <- elevenlabs.AudioEvent{PCM: []byte("b"), EventID: 1}
	conv.events <- elevenlabs.Interruption{EventID: 2}
	conv.events <- elevenlabs.AudioEvent{PCM: []byte("c"), EventID: 3}
	conv.events <- elevenlabs.UserTranscript{Text: "hi"}
	conv.events <- elevenlabs.AgentResponse{Text: "hello"}
	conv.events <- elevenlabs.AgentResponseCorrection{Corrected: "hel-"}
	conv.events <- elevenlabs.UnknownEvent{Type: "vad_score", Raw: []byte("{}")}
	conv.finish(websocket.CloseError{Code: websocket.StatusNormalClosure})

	if err := runBridge(t, context.Background(), rm, conv); err != nil {
		t.Fatalf("bridge = %v", err)
	}
	ops, _ := rm.snapshot()
	want := []string{"enqueue:a", "enqueue:b", "flush", "enqueue:c", "close"}
	if !slices.Equal(ops, want) {
		t.Fatalf("ops = %v, want %v", ops, want)
	}
}

func TestBridgeClientErrorFatal(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	conv.events <- elevenlabs.AudioEvent{PCM: []byte("a"), EventID: 1}
	conv.events <- elevenlabs.ClientError{Code: 1008, ErrorName: "rate_limited", Message: "too many"}
	// The events channel stays open: bridge must end the conversation itself.

	err := runBridge(t, context.Background(), rm, conv)
	if err == nil || !strings.Contains(err.Error(), "rate_limited") {
		t.Fatalf("bridge = %v", err)
	}
	ops, bufCalls := rm.snapshot()
	if bufCalls != 0 {
		t.Fatalf("drain polled %d times on a fatal error", bufCalls)
	}
	if !slices.Contains(ops, "close") {
		t.Fatal("room not closed")
	}
	if !conv.isClosed() {
		t.Fatal("conversation not closed")
	}
}

func TestBridgeDrainsOnCleanClose(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	rm.buffered = []time.Duration{60 * time.Millisecond, 40 * time.Millisecond, 20 * time.Millisecond, 0}
	conv.finish(websocket.CloseError{Code: websocket.StatusNormalClosure})

	if err := runBridge(t, context.Background(), rm, conv); err != nil {
		t.Fatalf("bridge = %v", err)
	}
	ops, bufCalls := rm.snapshot()
	if bufCalls != 4 {
		t.Fatalf("buffered polled %d times, want 4", bufCalls)
	}
	if len(ops) == 0 || ops[len(ops)-1] != "close" {
		t.Fatalf("ops = %v, want close last", ops)
	}
}

func TestBridgeNoDrainOnAbnormalClose(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	rm.buffered = []time.Duration{60 * time.Millisecond}
	conv.finish(websocket.CloseError{Code: websocket.StatusInternalError})

	err := runBridge(t, context.Background(), rm, conv)
	if websocket.CloseStatus(err) != websocket.StatusInternalError {
		t.Fatalf("bridge = %v", err)
	}
	if _, bufCalls := rm.snapshot(); bufCalls != 0 {
		t.Fatalf("drain polled %d times on an abnormal close", bufCalls)
	}
}

func TestBridgeSendErrorFatal(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	boom := errors.New("boom")
	conv.sendErrs = map[int]error{1: boom}
	rm.pcm <- []byte("a")
	rm.pcm <- []byte("b")

	err := runBridge(t, context.Background(), rm, conv)
	if !errors.Is(err, boom) {
		t.Fatalf("bridge = %v", err)
	}
	if _, bufCalls := rm.snapshot(); bufCalls != 0 {
		t.Fatalf("drain polled %d times after a send failure", bufCalls)
	}
}

func TestBridgeSendErrClosedBenign(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	conv.finish(websocket.CloseError{Code: websocket.StatusNormalClosure})
	rm.pcm <- []byte("a") // this send hits the closed conversation and gets net.ErrClosed

	if err := runBridge(t, context.Background(), rm, conv); err != nil {
		t.Fatalf("bridge = %v", err)
	}
	if _, bufCalls := rm.snapshot(); bufCalls == 0 {
		t.Fatal("drain skipped after a benign send error")
	}
}

func TestBridgeRoomDeathClean(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	rm.kill(nil)

	if err := runBridge(t, context.Background(), rm, conv); err != nil {
		t.Fatalf("bridge = %v", err)
	}
	if !conv.isClosed() {
		t.Fatal("conversation not closed after room death")
	}
}

func TestBridgeRoomDeathError(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	boom := errors.New("room: disconnected: boom")
	rm.kill(boom)

	if err := runBridge(t, context.Background(), rm, conv); !errors.Is(err, boom) {
		t.Fatalf("bridge = %v", err)
	}
}

func TestBridgeCtxCancel(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- bridge(ctx, rm, conv, discard) }()
	cancel()
	// The real room and conversation die on their own when ctx ends.
	rm.kill(context.Canceled)
	conv.finish(context.Canceled)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("bridge = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not return")
	}
}

func TestUplinkForwardsUntilClose(t *testing.T) {
	pcm := make(chan []byte, 2)
	pcm <- []byte("a")
	pcm <- []byte("b")
	close(pcm)
	var got [][]byte
	if err := uplink(pcm, func(p []byte) error { got = append(got, p); return nil }); err != nil {
		t.Fatalf("uplink = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("sends = %d, want 2", len(got))
	}
}

func TestUplinkErrClosedBenign(t *testing.T) {
	pcm := make(chan []byte, 2)
	pcm <- []byte("a")
	pcm <- []byte("b")
	close(pcm)
	sends := 0
	if err := uplink(pcm, func([]byte) error { sends++; return net.ErrClosed }); err != nil {
		t.Fatalf("uplink = %v", err)
	}
	if sends != 1 {
		t.Fatalf("sends = %d, want 1", sends)
	}
}

func TestUplinkRealErrorPropagates(t *testing.T) {
	pcm := make(chan []byte, 2)
	pcm <- []byte("a")
	pcm <- []byte("b")
	close(pcm)
	boom := errors.New("boom")
	sends := 0
	err := uplink(pcm, func([]byte) error {
		sends++
		if sends == 2 {
			return boom
		}
		return nil
	})
	if !errors.Is(err, boom) {
		t.Fatalf("uplink = %v", err)
	}
	if sends != 2 {
		t.Fatalf("sends = %d, want 2", sends)
	}
}

func TestDrainReachesZero(t *testing.T) {
	script := []time.Duration{40 * time.Millisecond, 20 * time.Millisecond, 0}
	calls := 0
	buffered := func() time.Duration {
		d := script[0]
		if len(script) > 1 {
			script = script[1:]
		}
		calls++
		return d
	}
	drain(context.Background(), buffered, make(chan struct{}), time.Minute, discard)
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
}

func TestDrainCapped(t *testing.T) {
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		drain(context.Background(), func() time.Duration { return time.Second }, make(chan struct{}), time.Millisecond, discard)
	}()
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("drain ignored its cap")
	}
}

func TestDrainAbortsOnDone(t *testing.T) {
	done := make(chan struct{})
	close(done)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		drain(context.Background(), func() time.Duration { return time.Second }, done, time.Minute, discard)
	}()
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("drain ignored the room ending")
	}
}

func TestDrainAbortsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		drain(ctx, func() time.Duration { return time.Second }, make(chan struct{}), time.Minute, discard)
	}()
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("drain ignored ctx cancel")
	}
}
