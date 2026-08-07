// Package session bridges one LiveKit room to one ElevenLabs conversation for one call.
package session

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/elevenlabs"
	"github.com/ayukumar261/ringback/apps/worker/internal/events"
	"github.com/ayukumar261/ringback/apps/worker/internal/room"
)

// Opts carries the per-worker configuration shared by every call.
type Opts struct {
	LiveKitURL       string
	LiveKitAPIKey    string
	LiveKitAPISecret string
	EL               *elevenlabs.Client
	Init             elevenlabs.InitData // per-call overrides, usually zero
	Direction        string              // events.DirectionInbound or events.DirectionOutbound, set by the entry point
	Events           *events.Publisher   // nil publishes nothing
	Log              *slog.Logger        // nil means slog.Default()
}

// Run bridges roomName to one agent conversation and blocks until the call ends.
func Run(ctx context.Context, roomName string, opts Opts) error {
	if roomName == "" || opts.EL == nil {
		return fmt.Errorf("session: run needs a room name and an ElevenLabs client")
	}
	log := opts.Log
	if log == nil {
		log = slog.Default()
	}
	log = log.With("room", roomName)

	rm, err := room.Join(ctx, room.Opts{
		URL:       opts.LiveKitURL,
		APIKey:    opts.LiveKitAPIKey,
		APISecret: opts.LiveKitAPISecret,
		RoomName:  roomName,
		Log:       log,
	})
	if err != nil {
		return setupErr(ctx, err)
	}
	conv, err := opts.EL.Start(ctx, elevenlabs.StartOpts{Init: opts.Init})
	if err != nil {
		rm.Close()
		return setupErr(ctx, err)
	}

	start := time.Now()
	log = log.With("conversation", conv.Meta().ConversationID)
	log.Info("session started")
	from, to := rm.Caller()
	opts.Events.CallStarted(events.Start{
		Room:           roomName,
		ConversationID: conv.Meta().ConversationID,
		From:           from,
		To:             to,
		Direction:      opts.Direction,
		At:             start,
	})
	err = bridge(ctx, rm, conv, newTurnLog(roomName, opts.Events.CallTurn), log)
	elapsed := time.Since(start)
	log.Info("session ended", "duration", elapsed.Round(time.Millisecond), "err", err)
	opts.Events.CallEnded(events.End{
		Room:     roomName,
		At:       time.Now(),
		Duration: elapsed,
	})
	return err
}

// setupErr keeps a join or start failure unless our own ctx caused it.
func setupErr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return nil
	}
	return err
}

// classify reduces the call's ending signals to one meaningful error or nil.
func classify(clientErr, roomErr, convErr, sendErr error) error {
	switch {
	case clientErr != nil:
		return clientErr
	case meaningful(roomErr):
		return roomErr
	case meaningful(convErr) && !cleanConvEnd(convErr):
		return fmt.Errorf("session: conversation: %w", convErr)
	case meaningful(sendErr):
		return fmt.Errorf("session: send: %w", sendErr)
	}
	return nil
}

// meaningful reports whether err is a real failure rather than our own cancellation.
func meaningful(err error) bool {
	return err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded)
}
