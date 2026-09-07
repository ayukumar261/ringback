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

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
	"github.com/ayukumar261/ringback/apps/worker/internal/events"
)

// discard is a logger for paths whose output the tests do not assert on.
var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

// discardTurns is a turnLog for tests that do not assert on the transcript.
func discardTurns() *turnLog {
	return newTurnLog("room", func(events.Turn) {})
}

// instant is a clock whose every wait is already over.
func instant(time.Duration) <-chan time.Time {
	ch := make(chan time.Time)
	close(ch)
	return ch
}

// fakeClock records every requested wait and fires only when the test says so.
type fakeClock struct {
	mu    sync.Mutex
	waits []time.Duration
	fire  chan time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{fire: make(chan time.Time)}
}

func (c *fakeClock) after(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.waits = append(c.waits, d)
	return c.fire
}

func (c *fakeClock) asked() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.waits)
}

// fakeRoom is a scriptable roomHandle that records operations in order.
type fakeRoom struct {
	pcm  chan []byte
	done chan struct{}

	mu       sync.Mutex
	err      error
	dtmfErr  error
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

// SendDTMF records the press unless the test scripted a failure.
func (f *fakeRoom) SendDTMF(digits string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.dtmfErr != nil {
		return f.dtmfErr
	}
	f.ops = append(f.ops, "dtmf:"+digits)
	return nil
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

// fakeConv is a scriptable agent.Conversation that records sent frames and tool results.
type fakeConv struct {
	events chan agent.Event

	mu       sync.Mutex
	err      error
	sends    [][]byte
	sendErrs map[int]error
	tools    []toolResult
	closed   bool
	evClosed bool
}

// toolResult is one SendTool call as the fake recorded it.
type toolResult struct {
	id     string
	result string
	isErr  bool
}

func newFakeConv() *fakeConv {
	return &fakeConv{events: make(chan agent.Event, 16)}
}

func (f *fakeConv) ID() string { return "conv-fake" }

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

func (f *fakeConv) SendTool(id, result string, isErr bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return net.ErrClosed
	}
	f.tools = append(f.tools, toolResult{id: id, result: result, isErr: isErr})
	return nil
}

func (f *fakeConv) Events() <-chan agent.Event { return f.events }

func (f *fakeConv) Err() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.err
}

func (f *fakeConv) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	f.closeEvents()
	return nil
}

// closeEvents ends the event stream once, whoever asks first.
func (f *fakeConv) closeEvents() {
	if !f.evClosed {
		f.evClosed = true
		close(f.events)
	}
}

// finish simulates the server ending the conversation with err.
func (f *fakeConv) finish(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		f.err = err
	}
	f.closeEvents()
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

func (f *fakeConv) results() []toolResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.tools)
}

// queue pushes events and closes the channel while leaving the conversation open for replies.
func (f *fakeConv) queue(evs ...agent.Event) {
	for _, ev := range evs {
		f.events <- ev
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closeEvents()
}

// runBridge runs bridge under a liveness timeout and returns its error.
func runBridge(t *testing.T, ctx context.Context, rm *fakeRoom, conv *fakeConv) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- bridge(ctx, rm, conv, discardTurns(), instant, discard) }()
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
	go func() { done <- bridge(context.Background(), rm, conv, discardTurns(), instant, discard) }()
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
	conv.events <- agent.Audio{PCM: []byte("a"), EventID: 1}
	conv.events <- agent.Audio{PCM: []byte("b"), EventID: 1}
	conv.events <- agent.Interruption{EventID: 2}
	conv.events <- agent.Audio{PCM: []byte("c"), EventID: 3}
	conv.events <- agent.UserTurn{Text: "hi"}
	conv.events <- agent.AgentTurn{Text: "hello"}
	conv.events <- agent.Correction{Corrected: "hel-"}
	conv.events <- agent.Unknown{Type: "vad_score", Raw: []byte("{}")}
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

func TestDownlinkRecordsTurns(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	conv.queue(
		agent.AgentTurn{Text: "Hello, how can I help?"},
		agent.UserTurn{Text: "What are your hours?"},
		agent.Correction{Original: "Hello, how can I help?", Corrected: "Hello, how-"},
	)

	turns, got := newTestTurnLog("call-a")
	if err := downlink(conv, rm, turns, instant, discard); err != nil {
		t.Fatalf("downlink = %v", err)
	}
	want := []events.Turn{
		{Room: "call-a", Seq: 1, Role: events.RoleAgent, Text: "Hello, how can I help?", At: time.UnixMilli(1753795200000)},
		{Room: "call-a", Seq: 2, Role: events.RoleUser, Text: "What are your hours?", At: time.UnixMilli(1753795200000)},
		{Room: "call-a", Seq: 1, Role: events.RoleAgent, Text: "Hello, how-", At: time.UnixMilli(1753795200000)},
	}
	if !slices.Equal(*got, want) {
		t.Fatalf("turns = %v, want %v", *got, want)
	}
}

func TestDownlinkRunsSendDTMF(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	conv.queue(agent.Tool{ID: "c1", Name: "send_dtmf", Params: []byte(`{"digits":"1"}`)})

	turns, recorded := newTestTurnLog("call-a")
	if err := downlink(conv, rm, turns, instant, discard); err != nil {
		t.Fatalf("downlink = %v", err)
	}
	ops, _ := rm.snapshot()
	if !slices.Equal(ops, []string{"dtmf:1"}) {
		t.Fatalf("ops = %v, want [dtmf:1]", ops)
	}
	want := []toolResult{{id: "c1", result: "pressed 1", isErr: false}}
	if got := conv.results(); !slices.Equal(got, want) {
		t.Fatalf("results = %v, want %v", got, want)
	}
	wantTurns := []events.Turn{
		{Room: "call-a", Seq: 1, Role: events.RoleTool, Text: "pressed 1", At: time.UnixMilli(1753795200000)},
	}
	if !slices.Equal(*recorded, wantTurns) {
		t.Fatalf("turns = %v, want %v", *recorded, wantTurns)
	}
}

func TestDownlinkToolErrors(t *testing.T) {
	invalid := errors.New("room: send dtmf: invalid digit 'a'")
	for _, tt := range []struct {
		name    string
		call    agent.Tool
		dtmfErr error
		wantMsg string
	}{
		{
			name:    "bad digit",
			call:    agent.Tool{ID: "c2", Name: "send_dtmf", Params: []byte(`{"digits":"a"}`)},
			dtmfErr: invalid,
			wantMsg: invalid.Error(),
		},
		{
			name:    "unknown tool",
			call:    agent.Tool{ID: "c3", Name: "hang_up", Params: []byte(`{}`)},
			wantMsg: "unknown tool",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rm, conv := newFakeRoom(), newFakeConv()
			rm.dtmfErr = tt.dtmfErr
			conv.queue(tt.call)

			turns, recorded := newTestTurnLog("call-a")
			if err := downlink(conv, rm, turns, instant, discard); err != nil {
				t.Fatalf("downlink = %v", err)
			}
			if ops, _ := rm.snapshot(); len(ops) != 0 {
				t.Fatalf("ops = %v, want none", ops)
			}
			if len(*recorded) != 0 {
				t.Fatalf("turns = %v, want none for a failed press", *recorded)
			}
			got := conv.results()
			if len(got) != 1 {
				t.Fatalf("results = %v, want one", got)
			}
			if got[0].id != tt.call.ID || !got[0].isErr || !strings.Contains(got[0].result, tt.wantMsg) {
				t.Fatalf("result = %+v, want is_error containing %q", got[0], tt.wantMsg)
			}
		})
	}
}

func TestDownlinkToolResultErrClosedBenign(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	conv.queue(agent.Tool{ID: "c5", Name: "send_dtmf", Params: []byte(`{"digits":"1"}`)})
	// The conversation ends before the reply goes out, so SendTool sees net.ErrClosed.
	conv.mu.Lock()
	conv.closed = true
	conv.mu.Unlock()

	if err := downlink(conv, rm, discardTurns(), instant, discard); err != nil {
		t.Fatalf("downlink = %v, want nil on a closed conversation", err)
	}
}

// startAnswer runs answerTool in the background and returns its result channel.
func startAnswer(rm *fakeRoom, conv *fakeConv, turns *turnLog, call agent.Tool, after clock) <-chan error {
	done := make(chan error, 1)
	go func() { done <- answerTool(conv, rm, turns, call, after, discard) }()
	return done
}

// awaitAnswer fails the test unless answerTool returns nil promptly.
func awaitAnswer(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("answerTool = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("answerTool did not return")
	}
}

func TestAnswerToolHoldsUntilTonesFinish(t *testing.T) {
	rm, conv, clk := newFakeRoom(), newFakeConv(), newFakeClock()
	turns, recorded := newTestTurnLog("call-a")
	done := startAnswer(rm, conv, turns, agent.Tool{ID: "c7", Name: "send_dtmf", Params: []byte(`{"digits":"1234"}`)}, clk.after)

	waitFor(t, func() bool { return len(clk.asked()) == 1 })
	if ops, _ := rm.snapshot(); !slices.Equal(ops, []string{"dtmf:1234"}) {
		t.Fatalf("ops = %v, want the press before the hold", ops)
	}
	if got := *recorded; len(got) != 1 || got[0].Role != events.RoleTool || got[0].Text != "pressed 1234" {
		t.Fatalf("turns = %v, want the tool turn recorded before the hold", got)
	}
	if got := clk.asked(); got[0] != 2*time.Second {
		t.Fatalf("hold = %v, want %v", got[0], 2*time.Second)
	}
	if got := conv.results(); len(got) != 0 {
		t.Fatalf("results = %v before the tones finished", got)
	}
	select {
	case err := <-done:
		t.Fatalf("answerTool = %v before the tones finished", err)
	default:
	}

	clk.fire <- time.Time{}
	awaitAnswer(t, done)
	want := []toolResult{{id: "c7", result: "pressed 1234", isErr: false}}
	if got := conv.results(); !slices.Equal(got, want) {
		t.Fatalf("results = %v, want %v", got, want)
	}
}

func TestAnswerToolHoldEndsWithRoom(t *testing.T) {
	rm, conv, clk := newFakeRoom(), newFakeConv(), newFakeClock()
	done := startAnswer(rm, conv, discardTurns(), agent.Tool{ID: "c8", Name: "send_dtmf", Params: []byte(`{"digits":"1"}`)}, clk.after)

	waitFor(t, func() bool { return len(clk.asked()) == 1 })
	rm.kill(nil)
	awaitAnswer(t, done)
	if got := conv.results(); len(got) != 1 || got[0].id != "c8" {
		t.Fatalf("results = %v, want the reply once the room ended", got)
	}
}

func TestAnswerToolNoHoldOnFailure(t *testing.T) {
	rm, conv, clk := newFakeRoom(), newFakeConv(), newFakeClock()
	rm.dtmfErr = errors.New("room: send dtmf: room closed")
	done := startAnswer(rm, conv, discardTurns(), agent.Tool{ID: "c9", Name: "send_dtmf", Params: []byte(`{"digits":"1"}`)}, clk.after)

	awaitAnswer(t, done)
	if got := clk.asked(); len(got) != 0 {
		t.Fatalf("clock asked for %v on a failed press", got)
	}
	if got := conv.results(); len(got) != 1 || !got[0].isErr {
		t.Fatalf("results = %v, want one error reply", got)
	}
}

func TestBridgeToolKeepsRoomOrder(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	conv.events <- agent.Audio{PCM: []byte("a"), EventID: 1}
	conv.events <- agent.Interruption{EventID: 2}
	conv.events <- agent.Tool{ID: "c6", Name: "send_dtmf", Params: []byte(`{"digits":"2#"}`)}
	conv.queue(agent.Audio{PCM: []byte("c"), EventID: 3})

	if err := runBridge(t, context.Background(), rm, conv); err != nil {
		t.Fatalf("bridge = %v", err)
	}
	ops, _ := rm.snapshot()
	want := []string{"enqueue:a", "flush", "dtmf:2#", "enqueue:c", "close"}
	if !slices.Equal(ops, want) {
		t.Fatalf("ops = %v, want %v", ops, want)
	}
	if got := conv.results(); len(got) != 1 || got[0].result != "pressed 2#" || got[0].isErr {
		t.Fatalf("results = %v, want one clean press", got)
	}
}

func TestBridgeClientErrorFatal(t *testing.T) {
	rm, conv := newFakeRoom(), newFakeConv()
	conv.events <- agent.Audio{PCM: []byte("a"), EventID: 1}
	conv.events <- agent.Error{Code: 1008, Name: "rate_limited", Message: "too many"}
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
	go func() { done <- bridge(ctx, rm, conv, discardTurns(), instant, discard) }()
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
