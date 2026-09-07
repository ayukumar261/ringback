package elevenlabs

import (
	"bytes"
	"context"
	"errors"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
)

func TestPingPong(t *testing.T) {
	_, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
		expectInit(t, ctx, conn)
		sendRaw(t, ctx, conn, metaFrame("conv_1", "pcm_48000", "pcm_48000"))
		sendRaw(t, ctx, conn, `{"type":"ping","ping_event":{"event_id":42,"ping_ms":50}}`)
		m := expectClientFrame(t, ctx, conn)
		if m["type"] != "pong" || m["event_id"] != float64(42) {
			t.Errorf("pong frame = %v", m)
		}
		conn.Close(websocket.StatusNormalClosure, "")
	})
	conv, err := client.Start(t.Context(), StartOpts{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	for ev := range conv.Events() {
		if u, ok := ev.(agent.Unknown); ok && u.Type == "ping" {
			t.Fatal("ping surfaced on Events")
		}
	}
	if conv.Err() == nil {
		t.Fatal("Err is nil after server close")
	}
}

func TestPingMissingPayload(t *testing.T) {
	_, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
		expectInit(t, ctx, conn)
		sendRaw(t, ctx, conn, metaFrame("conv_1", "pcm_48000", "pcm_48000"))
		sendRaw(t, ctx, conn, `{"type":"ping"}`)
		waitClose(ctx, conn)
	})
	conv, err := client.Start(t.Context(), StartOpts{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	for range conv.Events() {
	}
	if err := conv.Err(); err == nil || !strings.Contains(err.Error(), "missing ping_event payload") {
		t.Fatalf("Err = %v", err)
	}
}

func TestSendToolFrame(t *testing.T) {
	_, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
		expectInit(t, ctx, conn)
		sendRaw(t, ctx, conn, metaFrame("conv_1", "pcm_48000", "pcm_48000"))
		m := expectClientFrame(t, ctx, conn)
		if m["type"] != "client_tool_result" || m["tool_call_id"] != "call_1" || m["result"] != "sent" || m["is_error"] != true {
			t.Errorf("tool result frame = %v", m)
		}
		waitClose(ctx, conn)
	})
	conv, err := client.Start(t.Context(), StartOpts{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := conv.SendTool("call_1", "sent", true); err != nil {
		t.Fatalf("SendTool: %v", err)
	}
	conv.Close()
	if err := conv.SendTool("call_2", "late", false); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("SendTool after close = %v", err)
	}
}

func TestAudioInterruptionOrder(t *testing.T) {
	_, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
		expectInit(t, ctx, conn)
		sendRaw(t, ctx, conn, metaFrame("conv_1", "pcm_48000", "pcm_48000"))
		sendRaw(t, ctx, conn, audioFrame([]byte("a"), 1))
		sendRaw(t, ctx, conn, audioFrame([]byte("b"), 2))
		sendRaw(t, ctx, conn, `{"type":"interruption","interruption_event":{"event_id":3}}`)
		sendRaw(t, ctx, conn, audioFrame([]byte("c"), 4))
		conn.Close(websocket.StatusNormalClosure, "")
	})
	conv, err := client.Start(t.Context(), StartOpts{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	var got []agent.Event
	for ev := range conv.Events() {
		got = append(got, ev)
	}
	want := []agent.Event{
		agent.Audio{PCM: []byte("a"), EventID: 1},
		agent.Audio{PCM: []byte("b"), EventID: 2},
		agent.Interruption{EventID: 3},
		agent.Audio{PCM: []byte("c"), EventID: 4},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %#v", got)
	}
}

func TestServerCloseMidCall(t *testing.T) {
	_, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
		expectInit(t, ctx, conn)
		sendRaw(t, ctx, conn, metaFrame("conv_1", "pcm_48000", "pcm_48000"))
		sendRaw(t, ctx, conn, audioFrame([]byte("x"), 1))
		conn.Close(websocket.StatusInternalError, "boom")
	})
	conv, err := client.Start(t.Context(), StartOpts{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	var got []agent.Event
	for ev := range conv.Events() {
		got = append(got, ev)
	}
	if len(got) != 1 {
		t.Fatalf("events = %#v", got)
	}
	if websocket.CloseStatus(conv.Err()) != websocket.StatusInternalError {
		t.Fatalf("Err = %v", conv.Err())
	}
}

func TestCtxCancel(t *testing.T) {
	_, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
		expectInit(t, ctx, conn)
		sendRaw(t, ctx, conn, metaFrame("conv_1", "pcm_48000", "pcm_48000"))
		waitClose(ctx, conn)
	})
	ctx, cancel := context.WithCancel(t.Context())
	conv, err := client.Start(ctx, StartOpts{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	cancel()
	select {
	case _, open := <-conv.Events():
		if open {
			t.Fatal("unexpected event after cancel")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("events did not close after cancel")
	}
	if !errors.Is(conv.Err(), context.Canceled) {
		t.Fatalf("Err = %v", conv.Err())
	}
	if err := conv.SendAudio([]byte("x")); err == nil {
		t.Fatal("SendAudio succeeded after cancel")
	}
}

func TestOversizedFrame(t *testing.T) {
	pcm := bytes.Repeat([]byte{7}, 100000)
	_, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
		expectInit(t, ctx, conn)
		sendRaw(t, ctx, conn, metaFrame("conv_1", "pcm_48000", "pcm_48000"))
		sendRaw(t, ctx, conn, audioFrame(pcm, 1))
		waitClose(ctx, conn)
	})
	conv, err := client.Start(t.Context(), StartOpts{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	ev := <-conv.Events()
	audio, ok := ev.(agent.Audio)
	if !ok || !bytes.Equal(audio.PCM, pcm) {
		t.Fatalf("event = %#v", ev)
	}
	conv.Close()
}

func TestCloseIdempotentSendAfterClose(t *testing.T) {
	_, client := newFake(t, func(ctx context.Context, conn *websocket.Conn) {
		expectInit(t, ctx, conn)
		sendRaw(t, ctx, conn, metaFrame("conv_1", "pcm_48000", "pcm_48000"))
		waitClose(ctx, conn)
	})
	conv, err := client.Start(t.Context(), StartOpts{})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if err := conv.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	if err := conv.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if err := conv.SendAudio([]byte("x")); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("SendAudio after close = %v", err)
	}
	if conv.Err() != nil {
		t.Fatalf("Err = %v", conv.Err())
	}
}
