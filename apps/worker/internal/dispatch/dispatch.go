// Package dispatch turns LiveKit room events into running call sessions.
package dispatch

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	lkwebhook "github.com/livekit/protocol/webhook"

	"github.com/ayukumar261/ringback/apps/worker/internal/room"
	"github.com/ayukumar261/ringback/apps/worker/internal/session"
)

const (
	defaultRoomPrefix = "call-"
	defaultMaxCall    = 30 * time.Minute // backstop against sessions no hangup ever ends
	deleteTimeout     = 5 * time.Second  // cap on the post-session room delete call
)

// Config tunes one Dispatcher.
type Config struct {
	RoomPrefix string                                                              // empty means call-
	MaxCall    time.Duration                                                       // zero means 30m
	Run        func(ctx context.Context, roomName string, opts session.Opts) error // nil means session.Run
	Delete     func(ctx context.Context, roomName string) error                    // nil means LiveKit room deletion
	Log        *slog.Logger                                                        // nil means slog.Default()
}

// Dispatcher runs one session per call room and tears the room down when the session ends.
type Dispatcher struct {
	opts    session.Opts
	prefix  string
	maxCall time.Duration
	run     func(ctx context.Context, roomName string, opts session.Opts) error
	delete  func(ctx context.Context, roomName string) error
	log     *slog.Logger

	mu     sync.Mutex
	active map[string]context.CancelFunc
	wg     sync.WaitGroup
}

// New builds a Dispatcher whose sessions share opts.
func New(opts session.Opts, cfg Config) *Dispatcher {
	if cfg.RoomPrefix == "" {
		cfg.RoomPrefix = defaultRoomPrefix
	}
	if cfg.MaxCall == 0 {
		cfg.MaxCall = defaultMaxCall
	}
	if cfg.Run == nil {
		cfg.Run = session.Run
	}
	if cfg.Delete == nil {
		cfg.Delete = func(ctx context.Context, roomName string) error {
			return room.Delete(ctx, room.Opts{
				URL:       opts.LiveKitURL,
				APIKey:    opts.LiveKitAPIKey,
				APISecret: opts.LiveKitAPISecret,
				RoomName:  roomName,
			})
		}
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	return &Dispatcher{
		opts:    opts,
		prefix:  cfg.RoomPrefix,
		maxCall: cfg.MaxCall,
		run:     cfg.Run,
		delete:  cfg.Delete,
		log:     cfg.Log,
		active:  make(map[string]context.CancelFunc),
	}
}

// HandleEvent reacts to one webhook event; it never blocks on session work.
func (d *Dispatcher) HandleEvent(ev *livekit.WebhookEvent) {
	roomName := ev.GetRoom().GetName()
	if roomName == "" {
		return
	}
	switch ev.GetEvent() {
	case lkwebhook.EventRoomStarted:
		if strings.HasPrefix(roomName, d.prefix) {
			d.start(roomName)
		}
	case lkwebhook.EventRoomFinished:
		d.finish(roomName)
	}
}

// start spawns a session for roomName unless one is already live.
func (d *Dispatcher) start(roomName string) {
	d.mu.Lock()
	if _, ok := d.active[roomName]; ok {
		d.mu.Unlock()
		d.log.Debug("ignoring duplicate room_started", "room", roomName)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), d.maxCall)
	d.active[roomName] = cancel
	d.wg.Add(1)
	d.mu.Unlock()

	d.log.Info("dispatching session", "room", roomName)
	go func() {
		defer d.wg.Done()
		defer func() {
			dctx, dcancel := context.WithTimeout(context.Background(), deleteTimeout)
			if err := d.delete(dctx, roomName); err != nil {
				d.log.Warn("deleting room after session", "room", roomName, "err", err)
			}
			dcancel()
			d.mu.Lock()
			delete(d.active, roomName)
			d.mu.Unlock()
			cancel()
		}()
		if err := d.run(ctx, roomName, d.opts); err != nil {
			d.log.Error("session failed", "room", roomName, "err", err)
		}
	}()
}

// finish cancels roomName's session if one is live.
func (d *Dispatcher) finish(roomName string) {
	d.mu.Lock()
	cancel, ok := d.active[roomName]
	d.mu.Unlock()
	if ok {
		cancel()
	}
}

// Drain cancels every live session and waits for them to end, bounded by ctx.
func (d *Dispatcher) Drain(ctx context.Context) {
	d.mu.Lock()
	for _, cancel := range d.active {
		cancel()
	}
	d.mu.Unlock()

	done := make(chan struct{})
	go func() {
		d.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}
