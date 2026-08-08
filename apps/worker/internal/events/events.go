// Package events publishes call lifecycle events to the Redis stream the api consumes.
package events

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Stream is the Redis stream key carrying every call lifecycle event.
const Stream = "ringback:calls"

const (
	maxLen         = 100_000 // approximate cap; Mongo holds the durable copy
	publishTimeout = time.Second
)

// Start describes one call the moment its agent conversation is live.
type Start struct {
	Room           string
	ConversationID string
	From           string // caller's number, empty if the SIP participant was not visible
	To             string // dialed number, empty likewise
	Direction      string // room.DirectionInbound or room.DirectionOutbound, empty if unknown
	At             time.Time
}

// End describes how one call finished.
type End struct {
	Room     string
	At       time.Time
	Duration time.Duration
}

// Turn roles.
const (
	RoleCaller = "caller"
	RoleAgent  = "agent"
)

// Turn is one utterance in a call's transcript.
type Turn struct {
	Room string
	Seq  int    // 1-based position within the call; a repeated Seq corrects earlier text
	Role string // RoleCaller or RoleAgent
	Text string
	At   time.Time
}

// xadder is the one Redis command the publisher needs.
type xadder interface {
	XAdd(ctx context.Context, a *redis.XAddArgs) *redis.StringCmd
}

// Publisher appends call events to the stream. Nil publishes nothing.
type Publisher struct {
	rdb xadder
	log *slog.Logger
}

// New builds a Publisher on rdb.
func New(rdb xadder, log *slog.Logger) *Publisher {
	if log == nil {
		log = slog.Default()
	}
	return &Publisher{rdb: rdb, log: log}
}

// CallStarted announces a live call.
func (p *Publisher) CallStarted(s Start) {
	if p == nil {
		return
	}
	p.publish(map[string]any{
		"event":           "call.started",
		"room":            s.Room,
		"conversation_id": s.ConversationID,
		"from":            s.From,
		"to":              s.To,
		"direction":       s.Direction,
		"started_at":      strconv.FormatInt(s.At.UnixMilli(), 10),
	})
}

// CallTurn announces one transcript turn.
func (p *Publisher) CallTurn(t Turn) {
	if p == nil {
		return
	}
	p.publish(map[string]any{
		"event": "call.turn",
		"room":  t.Room,
		"seq":   strconv.Itoa(t.Seq),
		"role":  t.Role,
		"text":  t.Text,
		"at":    strconv.FormatInt(t.At.UnixMilli(), 10),
	})
}

// CallEnded announces a finished call.
func (p *Publisher) CallEnded(e End) {
	if p == nil {
		return
	}
	p.publish(map[string]any{
		"event":       "call.ended",
		"room":        e.Room,
		"ended_at":    strconv.FormatInt(e.At.UnixMilli(), 10),
		"duration_ms": strconv.FormatInt(e.Duration.Milliseconds(), 10),
	})
}

// publish appends one entry, bounded by its own timeout so a Redis stall never holds a call.
func (p *Publisher) publish(values map[string]any) {
	ctx, cancel := context.WithTimeout(context.Background(), publishTimeout)
	defer cancel()
	err := p.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: Stream,
		MaxLen: maxLen,
		Approx: true,
		Values: values,
	}).Err()
	if err != nil {
		p.log.Warn("dropping call event", "event", values["event"], "room", values["room"], "err", err)
	}
}
