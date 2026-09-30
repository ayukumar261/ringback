package events

import (
	"context"
	"errors"
	"maps"
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
	p.CallStarted(Start{Room: "call-a", ConversationID: "conv-1", From: "+14155550100", To: "+18005550199", Direction: "outbound", Prompt: "Order a pizza.", At: at})

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
		"direction":       "outbound",
		"prompt":          "Order a pizza.",
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
	p.CallEnded(End{Room: "call-a", At: at, Duration: 121 * time.Second, Audio: "call-a.wav"})

	values := fake.args[0].Values.(map[string]any)
	want := map[string]any{
		"event":       "call.ended",
		"room":        "call-a",
		"ended_at":    "1753795321456",
		"duration_ms": "121000",
		"audio":       "call-a.wav",
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

func TestCallTurnOptionalSpans(t *testing.T) {
	start := time.UnixMilli(1753795210000)
	for _, tt := range []struct {
		name           string
		started, ended time.Time
		want           map[string]any
	}{
		{name: "no audio", want: map[string]any{}},
		{name: "start only", started: start, want: map[string]any{"started_at": "1753795210000"}},
		{name: "finished", started: start, ended: start.Add(240 * time.Millisecond), want: map[string]any{
			"started_at": "1753795210000", "ended_at": "1753795210240", "duration_ms": "240",
		}},
		{name: "cut off before playout", started: start, ended: start, want: map[string]any{
			"started_at": "1753795210000", "ended_at": "1753795210000", "duration_ms": "0",
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			fake := &fakeXAdder{}
			New(fake, nil).CallTurn(Turn{Room: "call-a", Seq: 1, Role: RoleAgent, Text: "Hello", At: start, Started: tt.started, Ended: tt.ended})
			values := fake.args[0].Values.(map[string]any)
			got := map[string]any{}
			for _, key := range []string{"started_at", "ended_at", "duration_ms"} {
				if v, ok := values[key]; ok {
					got[key] = v
				}
			}
			if !maps.Equal(got, tt.want) {
				t.Fatalf("span = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestCallEndedRecordingStart(t *testing.T) {
	fake := &fakeXAdder{}
	New(fake, nil).CallEnded(End{Room: "call-a", Audio: "call-a.wav", AudioStartedAt: time.UnixMilli(1753795200123)})
	if got := fake.args[0].Values.(map[string]any)["audio_started_at"]; got != "1753795200123" {
		t.Fatalf("audio_started_at = %v", got)
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
