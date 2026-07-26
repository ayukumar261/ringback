package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/livekit/protocol/auth"

	"github.com/ayukumar261/ringback/apps/worker/internal/dispatch"
	"github.com/ayukumar261/ringback/apps/worker/internal/elevenlabs"
	"github.com/ayukumar261/ringback/apps/worker/internal/session"
	"github.com/ayukumar261/ringback/apps/worker/internal/webhook"
)

var version = "dev"

const shutdownTimeout = 10 * time.Second

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	addr := os.Getenv("WORKER_HTTP_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	lkURL := mustEnv("LIVEKIT_URL", log)
	lkKey := mustEnv("LIVEKIT_API_KEY", log)
	lkSecret := mustEnv("LIVEKIT_API_SECRET", log)
	elKey := mustEnv("ELEVENLABS_API_KEY", log)
	elAgent := mustEnv("ELEVENLABS_AGENT_ID", log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	d := dispatch.New(session.Opts{
		LiveKitURL:       lkURL,
		LiveKitAPIKey:    lkKey,
		LiveKitAPISecret: lkSecret,
		EL:               &elevenlabs.Client{APIKey: elKey, AgentID: elAgent},
		Log:              log,
	}, dispatch.Config{Log: log})

	srv := webhook.NewServer(addr, version, auth.NewSimpleKeyProvider(lkKey, lkSecret), d.HandleEvent, log)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	log.Info("worker started", "addr", addr, "version", version)

	failed := false
	select {
	case <-ctx.Done():
		log.Info("shutdown signal received")
	case err := <-errCh:
		log.Error("http server failed", "err", err)
		failed = true
	}

	// Stop accepting webhooks first so no new sessions spawn mid-drain.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("shutdown", "err", err)
		failed = true
	}
	d.Drain(shutdownCtx)

	if failed {
		os.Exit(1)
	}
	log.Info("worker stopped")
}

// mustEnv returns the named variable or exits with a clear message.
func mustEnv(name string, log *slog.Logger) string {
	v := os.Getenv(name)
	if v == "" {
		log.Error("missing required environment variable", "name", name)
		os.Exit(1)
	}
	return v
}
