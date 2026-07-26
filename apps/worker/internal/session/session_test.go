package session

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/coder/websocket"

	"github.com/ayukumar261/ringback/apps/worker/internal/elevenlabs"
)

func TestClassify(t *testing.T) {
	clientErr := errors.New("session: agent error: rate_limited: too many")
	roomErr := errors.New("room: disconnected: DUPLICATE_IDENTITY")
	convAbnormal := websocket.CloseError{Code: websocket.StatusInternalError}
	convClean := websocket.CloseError{Code: websocket.StatusNormalClosure}
	sendErr := errors.New("write failed")

	tests := []struct {
		name                                 string
		clientErr, roomErr, convErr, sendErr error
		want                                 string // empty means nil
	}{
		{name: "all nil"},
		{name: "client error wins", clientErr: clientErr, roomErr: roomErr, convErr: convAbnormal, sendErr: sendErr, want: "agent error"},
		{name: "room error next", roomErr: roomErr, convErr: convAbnormal, sendErr: sendErr, want: "room:"},
		{name: "conv abnormal close", convErr: convAbnormal, sendErr: sendErr, want: "session: conversation"},
		{name: "conv normal close is clean", convErr: convClean},
		{name: "send error last", sendErr: sendErr, want: "session: send"},
		{name: "canceled room is clean", roomErr: context.Canceled},
		{name: "deadline room is clean", roomErr: context.DeadlineExceeded},
		{name: "canceled conv is clean", convErr: context.Canceled},
		{name: "canceled send is clean", sendErr: context.Canceled},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := classify(tt.clientErr, tt.roomErr, tt.convErr, tt.sendErr)
			if tt.want == "" {
				if err != nil {
					t.Fatalf("classify = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("classify = %v, want containing %q", err, tt.want)
			}
		})
	}
}

func TestRunValidation(t *testing.T) {
	if err := Run(t.Context(), "", Opts{EL: &elevenlabs.Client{}}); err == nil {
		t.Fatal("empty room name accepted")
	}
	if err := Run(t.Context(), "call-1", Opts{}); err == nil {
		t.Fatal("nil client accepted")
	}
}
