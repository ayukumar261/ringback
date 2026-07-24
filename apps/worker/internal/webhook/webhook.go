package webhook

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
)

type Server struct {
	http *http.Server
	log  *slog.Logger
}

func NewServer(addr, version string, log *slog.Logger) *Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"status":  "ok",
			"version": version,
		})
	})

	return &Server{
		http: &http.Server{Addr: addr, Handler: mux},
		log:  log,
	}
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
