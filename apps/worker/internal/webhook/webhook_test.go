package webhook

import (
	"crypto/sha256"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
)

const (
	testKey    = "test-key"
	testSecret = "test-secret-0123456789abcdefghij"
)

// sign returns the JWT LiveKit would attach when delivering body.
func sign(t *testing.T, body, key, secret string) string {
	t.Helper()
	sum := sha256.Sum256([]byte(body))
	token, err := auth.NewAccessToken(key, secret).
		SetValidFor(time.Minute).
		SetSha256(base64.StdEncoding.EncodeToString(sum[:])).
		ToJWT()
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return token
}

// newTestServer builds a server with test keys and a capturing event sink.
func newTestServer(onEvent func(*livekit.WebhookEvent)) *Server {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewServer("127.0.0.1:0", "test", auth.NewSimpleKeyProvider(testKey, testSecret), onEvent, log)
}

// post delivers body to POST /livekit with an optional Authorization token.
func post(s *Server, body, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "/livekit", strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	w := httptest.NewRecorder()
	s.http.Handler.ServeHTTP(w, req)
	return w
}

func TestAcceptsSignedEvent(t *testing.T) {
	var got *livekit.WebhookEvent
	s := newTestServer(func(ev *livekit.WebhookEvent) { got = ev })

	body := `{"event":"room_started","room":{"name":"call-abc"}}`
	w := post(s, body, sign(t, body, testKey, testSecret))

	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want %d", w.Code, http.StatusOK)
	}
	if got == nil {
		t.Fatal("event never reached the sink")
	}
	if got.GetEvent() != "room_started" || got.GetRoom().GetName() != "call-abc" {
		t.Fatalf("sink got event %q room %q", got.GetEvent(), got.GetRoom().GetName())
	}
}

func TestRejectsTamperedBody(t *testing.T) {
	called := false
	s := newTestServer(func(*livekit.WebhookEvent) { called = true })

	token := sign(t, `{"event":"room_started","room":{"name":"call-abc"}}`, testKey, testSecret)
	w := post(s, `{"event":"room_started","room":{"name":"call-evil"}}`, token)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want %d", w.Code, http.StatusUnauthorized)
	}
	if called {
		t.Fatal("tampered event reached the sink")
	}
}

func TestRejectsWrongSecret(t *testing.T) {
	called := false
	s := newTestServer(func(*livekit.WebhookEvent) { called = true })

	body := `{"event":"room_started","room":{"name":"call-abc"}}`
	w := post(s, body, sign(t, body, testKey, "not-the-secret-not-the-secret-no"))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want %d", w.Code, http.StatusUnauthorized)
	}
	if called {
		t.Fatal("badly signed event reached the sink")
	}
}

func TestRejectsMissingAuth(t *testing.T) {
	called := false
	s := newTestServer(func(*livekit.WebhookEvent) { called = true })

	w := post(s, `{"event":"room_started","room":{"name":"call-abc"}}`, "")

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want %d", w.Code, http.StatusUnauthorized)
	}
	if called {
		t.Fatal("unsigned event reached the sink")
	}
}

func TestWebhookRouteAbsentWithoutKeys(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	s := NewServer("127.0.0.1:0", "test", nil, nil, log)

	w := post(s, `{"event":"room_started"}`, "")
	if w.Code != http.StatusNotFound {
		t.Fatalf("status %d, want %d", w.Code, http.StatusNotFound)
	}

	req := httptest.NewRequest("GET", "/healthz", nil)
	hw := httptest.NewRecorder()
	s.http.Handler.ServeHTTP(hw, req)
	if hw.Code != http.StatusOK {
		t.Fatalf("healthz status %d, want %d", hw.Code, http.StatusOK)
	}
}
