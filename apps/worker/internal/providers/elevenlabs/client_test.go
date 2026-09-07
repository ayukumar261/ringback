package elevenlabs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
)

type fakeState struct {
	signedURLCalls atomic.Int32
}

func newFake(t *testing.T, script func(ctx context.Context, conn *websocket.Conn)) (*fakeState, *Client) {
	t.Helper()
	state := &fakeState{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/convai/conversation/get-signed-url", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("xi-api-key") != "test-key" {
			http.Error(w, "bad api key", http.StatusUnauthorized)
			return
		}
		if r.URL.Query().Get("agent_id") != "agent_test" {
			http.Error(w, "bad agent id", http.StatusBadRequest)
			return
		}
		state.signedURLCalls.Add(1)
		fmt.Fprintf(w, `{"signed_url":"ws://%s/ws?token=sig-abc"}`, r.Host)
	})
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != "sig-abc" {
			http.Error(w, "bad token", http.StatusForbidden)
			return
		}
		if r.Header.Get("xi-api-key") != "" {
			t.Error("api key leaked onto the websocket request")
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		defer conn.CloseNow()
		conn.SetReadLimit(-1)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		script(ctx, conn)
	})
	hs := httptest.NewServer(mux)
	t.Cleanup(hs.Close)
	client := &Client{APIKey: "test-key", AgentID: "agent_test", BaseURL: hs.URL, HTTPClient: hs.Client()}
	return state, client
}

func expectClientFrame(t *testing.T, ctx context.Context, conn *websocket.Conn) map[string]any {
	t.Helper()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Errorf("read client frame: %v", err)
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Errorf("client frame not json: %v", err)
		return nil
	}
	return m
}

func expectInit(t *testing.T, ctx context.Context, conn *websocket.Conn) map[string]any {
	t.Helper()
	m := expectClientFrame(t, ctx, conn)
	if m == nil || m["type"] != "conversation_initiation_client_data" {
		t.Errorf("first client frame = %v", m)
	}
	return m
}

// promptOf digs the call's prompt out of a decoded init frame, empty when absent.
func promptOf(m map[string]any) string {
	cfg, _ := m["conversation_config_override"].(map[string]any)
	ag, _ := cfg["agent"].(map[string]any)
	pr, _ := ag["prompt"].(map[string]any)
	s, _ := pr["prompt"].(string)
	return s
}

func sendRaw(t *testing.T, ctx context.Context, conn *websocket.Conn, s string) {
	t.Helper()
	if err := conn.Write(ctx, websocket.MessageText, []byte(s)); err != nil {
		t.Errorf("send: %v", err)
	}
}

func waitClose(ctx context.Context, conn *websocket.Conn) {
	for {
		if _, _, err := conn.Read(ctx); err != nil {
			return
		}
	}
}

func metaFrame(convID, inFmt, outFmt string) string {
	return fmt.Sprintf(`{"type":"conversation_initiation_metadata","conversation_initiation_metadata_event":{"conversation_id":%q,"agent_output_audio_format":%q,"user_input_audio_format":%q}}`, convID, outFmt, inFmt)
}

func audioFrame(pcm []byte, id int) string {
	return fmt.Sprintf(`{"type":"audio","audio_event":{"audio_base_64":%q,"event_id":%d}}`, base64.StdEncoding.EncodeToString(pcm), id)
}

func TestStartHappyPath(t *testing.T) {
	state, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
		m := expectInit(t, ctx, conn)
		if got := promptOf(m); got != "Be brief." {
			t.Errorf("init prompt = %q", got)
		}
		sendRaw(t, ctx, conn, metaFrame("conv_1", "pcm_48000", "pcm_48000"))
		sendRaw(t, ctx, conn, audioFrame([]byte("hi"), 1))
		waitClose(ctx, conn)
	})
	conv, err := client.Start(t.Context(), agent.Start{Prompt: "Be brief."})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if conv.ID() != "conv_1" {
		t.Fatalf("id = %q", conv.ID())
	}
	ev := <-conv.Events()
	audio, ok := ev.(agent.Audio)
	if !ok || string(audio.PCM) != "hi" || audio.EventID != 1 {
		t.Fatalf("first event = %#v", ev)
	}
	if err := conv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, open := <-conv.Events(); open {
		t.Fatal("events still open after Close")
	}
	if conv.Err() != nil {
		t.Fatalf("Err = %v", conv.Err())
	}
	if n := state.signedURLCalls.Load(); n != 1 {
		t.Fatalf("signed url calls = %d", n)
	}
}

func TestFormatMismatch(t *testing.T) {
	_, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
		expectInit(t, ctx, conn)
		sendRaw(t, ctx, conn, metaFrame("conv_1", "pcm_48000", "ulaw_8000"))
		waitClose(ctx, conn)
	})
	_, err := client.Start(t.Context(), agent.Start{})
	if err == nil || !strings.Contains(err.Error(), "ulaw_8000") || !strings.Contains(err.Error(), "pcm_48000") {
		t.Fatalf("err = %v", err)
	}
}

func TestHandshakeRejected(t *testing.T) {
	t.Run("client error", func(t *testing.T) {
		_, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
			expectInit(t, ctx, conn)
			sendRaw(t, ctx, conn, `{"type":"client_error","error_event":{"code":1008,"error_name":"rate_limited","message":"too many"}}`)
			waitClose(ctx, conn)
		})
		_, err := client.Start(t.Context(), agent.Start{})
		if err == nil || !strings.Contains(err.Error(), "rate_limited") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("metadata missing payload", func(t *testing.T) {
		_, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
			expectInit(t, ctx, conn)
			sendRaw(t, ctx, conn, `{"type":"conversation_initiation_metadata"}`)
			waitClose(ctx, conn)
		})
		_, err := client.Start(t.Context(), agent.Start{})
		if err == nil || !strings.Contains(err.Error(), "missing conversation_initiation_metadata_event payload") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("unexpected first frame", func(t *testing.T) {
		_, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
			expectInit(t, ctx, conn)
			sendRaw(t, ctx, conn, `{"type":"agent_response","agent_response_event":{"agent_response":"hi","event_id":1}}`)
			waitClose(ctx, conn)
		})
		_, err := client.Start(t.Context(), agent.Start{})
		if err == nil || !strings.Contains(err.Error(), "unexpected first frame") {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestSignedURLErrors(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
		want    string
	}{
		{
			name:    "server error",
			handler: func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", http.StatusInternalServerError) },
			want:    "status 500",
		},
		{
			name:    "junk body",
			handler: func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "not json") },
			want:    "signed url response",
		},
		{
			name:    "empty url",
			handler: func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"signed_url":""}`) },
			want:    "missing signed_url",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("GET /v1/convai/conversation/get-signed-url", tt.handler)
			mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
				t.Error("websocket route hit")
			})
			hs := httptest.NewServer(mux)
			t.Cleanup(hs.Close)
			client := &Client{APIKey: "k", AgentID: "a", BaseURL: hs.URL, HTTPClient: hs.Client()}
			_, err := client.Start(t.Context(), agent.Start{})
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v", err)
			}
		})
	}
}

func TestSignedURLPerStart(t *testing.T) {
	state, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
		expectInit(t, ctx, conn)
		sendRaw(t, ctx, conn, metaFrame("conv_1", "pcm_48000", "pcm_48000"))
		waitClose(ctx, conn)
	})
	for i := range 2 {
		conv, err := client.Start(t.Context(), agent.Start{})
		if err != nil {
			t.Fatalf("Start %d: %v", i, err)
		}
		conv.Close()
	}
	if n := state.signedURLCalls.Load(); n != 2 {
		t.Fatalf("signed url calls = %d", n)
	}
}
