package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/webhook"
)

var version = "dev"

func main() {
	addr := os.Getenv("WORKER_HTTP_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	srv := webhook.NewServer(addr, version, log)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe() }()
	log.Info("worker started", "addr", addr, "version", version)

	select {
	case <-ctx.Done():
		log.Info("shutdown signal received")
	case err := <-errCh:
		log.Error("http server failed", "err", err)
		os.Exit(1)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error("shutdown", "err", err)
		os.Exit(1)
	}
	log.Info("worker stopped")
}
