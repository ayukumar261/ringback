package events

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// fakeXAdder records every XAdd and answers with a canned result.
type fakeXAdder struct {
	args []*redis.XAddArgs
	err  error
}

func (f *fakeXAdder) XAdd(ctx context.Context, a *redis.XAddArgs) *redis.StringCmd {
	f.args = append(f.args, a)
	cmd := redis.NewStringCmd(ctx)
	if f.err != nil {
		cmd.SetErr(f.err)
	} else {
		cmd.SetVal("1-1")
	}
	return cmd
}

func TestCallStartedValues(t *testing.T) {
	fake := &fakeXAdder{}
	p := New(fake, nil)

	at := time.UnixMilli(1753795200123)
	p.CallStarted(Start{Room: "call-a", ConversationID: "conv-1", From: "+14155550100", To: "+18005550199", Direction: DirectionInbound, At: at})

	if len(fake.args) != 1 {
		t.Fatalf("XAdd calls = %d, want 1", len(fake.args))
	}
	a := fake.args[0]
	if a.Stream != Stream {
		t.Fatalf("stream = %q, want %q", a.Stream, Stream)
	}
	if !a.Approx || a.MaxLen != maxLen {
		t.Fatalf("trim = approx %v maxlen %d, want approx true maxlen %d", a.Approx, a.MaxLen, maxLen)
	}
	want := map[string]any{
		"event":           "call.started",
		"room":            "call-a",
		"conversation_id": "conv-1",
		"from":            "+14155550100",
		"to":              "+18005550199",
		"direction":       "inbound",
		"started_at":      "1753795200123",
	}
	values := a.Values.(map[string]any)
	for k, v := range want {
		if values[k] != v {
			t.Errorf("values[%q] = %v, want %v", k, values[k], v)
		}
	}
	if len(values) != len(want) {
		t.Errorf("values has %d fields, want %d", len(values), len(want))
	}
}

func TestCallEndedValues(t *testing.T) {
	fake := &fakeXAdder{}
	p := New(fake, nil)

	at := time.UnixMilli(1753795321456)
	p.CallEnded(End{Room: "call-a", At: at, Duration: 121 * time.Second})

	values := fake.args[0].Values.(map[string]any)
	want := map[string]any{
		"event":       "call.ended",
		"room":        "call-a",
		"ended_at":    "1753795321456",
		"duration_ms": "121000",
	}
	for k, v := range want {
		if values[k] != v {
			t.Errorf("values[%q] = %v, want %v", k, values[k], v)
		}
	}
	if len(values) != len(want) {
		t.Errorf("values has %d fields, want %d", len(values), len(want))
	}
}

func TestCallTurnValues(t *testing.T) {
	fake := &fakeXAdder{}
	p := New(fake, nil)

	at := time.UnixMilli(1753795210789)
	p.CallTurn(Turn{Room: "call-a", Seq: 3, Role: RoleAgent, Text: "How can I help?", At: at})

	values := fake.args[0].Values.(map[string]any)
	want := map[string]any{
		"event": "call.turn",
		"room":  "call-a",
		"seq":   "3",
		"role":  "agent",
		"text":  "How can I help?",
		"at":    "1753795210789",
	}
	for k, v := range want {
		if values[k] != v {
			t.Errorf("values[%q] = %v, want %v", k, values[k], v)
		}
	}
	if len(values) != len(want) {
		t.Errorf("values has %d fields, want %d", len(values), len(want))
	}
}

func TestNilPublisherPublishesNothing(t *testing.T) {
	var p *Publisher
	p.CallStarted(Start{Room: "call-a"})
	p.CallTurn(Turn{Room: "call-a", Seq: 1})
	p.CallEnded(End{Room: "call-a"})
}

func TestPublishFailureIsDropped(t *testing.T) {
	fake := &fakeXAdder{err: errors.New("connection refused")}
	p := New(fake, nil)
	p.CallStarted(Start{Room: "call-a"})
	p.CallEnded(End{Room: "call-a"})
	if len(fake.args) != 2 {
		t.Fatalf("XAdd calls = %d, want 2", len(fake.args))
	}
}
