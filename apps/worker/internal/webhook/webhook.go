// Package webhook serves the worker's HTTP endpoints: health plus verified LiveKit events.
package webhook

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lkwebhook "github.com/livekit/protocol/webhook"
)

// Server routes health checks and signed LiveKit webhook events.
type Server struct {
	http    *http.Server
	log     *slog.Logger
	keys    auth.KeyProvider
	onEvent func(*livekit.WebhookEvent)
}

// NewServer builds the server; keys plus onEvent enable the POST /livekit route.
func NewServer(addr, version string, keys auth.KeyProvider, onEvent func(*livekit.WebhookEvent), log *slog.Logger) *Server {
	s := &Server{log: log, keys: keys, onEvent: onEvent}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "ok",
			"version": version,
		})
	})
	if keys != nil && onEvent != nil {
		mux.HandleFunc("POST /livekit", s.handleLiveKit)
	}

	s.http = &http.Server{Addr: addr, Handler: mux}
	return s
}

// handleLiveKit rejects events that fail signature verification and forwards the rest.
func (s *Server) handleLiveKit(w http.ResponseWriter, r *http.Request) {
	ev, err := lkwebhook.ReceiveWebhookEvent(r, s.keys)
	if err != nil {
		s.log.Warn("rejected livekit webhook", "err", err)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	s.onEvent(ev)
	w.WriteHeader(http.StatusOK)
}

func (s *Server) ListenAndServe() error {
	err := s.http.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.http.Shutdown(ctx)
}
