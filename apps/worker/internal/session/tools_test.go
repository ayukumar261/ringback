package session

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
)

func TestRunToolSendDTMF(t *testing.T) {
	for _, tt := range []struct {
		name   string
		params string
		digits string
	}{
		{name: "single key", params: `{"digits":"1"}`, digits: "1"},
		{name: "menu path", params: `{"digits":"2#"}`, digits: "2#"},
		{name: "ignores extra fields", params: `{"digits":"9","reason":"agent"}`, digits: "9"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rm := newFakeRoom()
			got, err := runTool(rm, agent.Tool{ID: "c1", Name: "send_dtmf", Params: []byte(tt.params)})
			if err != nil {
				t.Fatalf("runTool = %v", err)
			}
			if want := "pressed " + tt.digits; got != want {
				t.Fatalf("result = %q, want %q", got, want)
			}
			if ops, _ := rm.snapshot(); !slices.Equal(ops, []string{"dtmf:" + tt.digits}) {
				t.Fatalf("ops = %v, want [dtmf:%s]", ops, tt.digits)
			}
		})
	}
}

func TestRunToolErrors(t *testing.T) {
	invalid := errors.New("room: send dtmf: invalid digit 'a'")
	for _, tt := range []struct {
		name    string
		call    agent.Tool
		dtmfErr error
		wantMsg string
		wantIs  error
	}{
		{
			name:    "room rejects digit",
			call:    agent.Tool{Name: "send_dtmf", Params: []byte(`{"digits":"a"}`)},
			dtmfErr: invalid,
			wantMsg: invalid.Error(),
			wantIs:  invalid,
		},
		{
			name:    "wrong param type",
			call:    agent.Tool{Name: "send_dtmf", Params: []byte(`{"digits":1}`)},
			wantMsg: "send_dtmf: bad params",
		},
		{
			name:    "malformed json",
			call:    agent.Tool{Name: "send_dtmf", Params: []byte(`{"digits":`)},
			wantMsg: "send_dtmf: bad params",
		},
		{
			name:    "unknown tool",
			call:    agent.Tool{Name: "hang_up", Params: []byte(`{}`)},
			wantMsg: `unknown tool "hang_up"`,
		},
		{
			name:    "empty name",
			call:    agent.Tool{Params: []byte(`{}`)},
			wantMsg: `unknown tool ""`,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rm := newFakeRoom()
			rm.dtmfErr = tt.dtmfErr
			got, err := runTool(rm, tt.call)
			if err == nil {
				t.Fatalf("runTool = %q, want error", got)
			}
			if got != "" {
				t.Fatalf("result = %q, want empty on error", got)
			}
			if !strings.Contains(err.Error(), tt.wantMsg) {
				t.Fatalf("err = %v, want containing %q", err, tt.wantMsg)
			}
			if tt.wantIs != nil && !errors.Is(err, tt.wantIs) {
				t.Fatalf("err = %v, want wrapping the room error", err)
			}
			if ops, _ := rm.snapshot(); len(ops) != 0 {
				t.Fatalf("ops = %v, want none", ops)
			}
		})
	}
}
