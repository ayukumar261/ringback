package session

import (
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/events"
)

// turnLog numbers a call's transcript turns and hands them to sink in order.
type turnLog struct {
	room      string
	sink      func(events.Turn)
	now       func() time.Time
	next      int
	lastAgent int // seq of the newest agent turn, 0 before any
}

// newTurnLog builds a turnLog for room whose turns land on sink.
func newTurnLog(room string, sink func(events.Turn)) *turnLog {
	return &turnLog{room: room, sink: sink, now: time.Now, next: 1}
}

// caller records what the caller said.
func (t *turnLog) caller(text string) {
	t.emit(t.take(), events.RoleCaller, text)
}

// agent records what the agent said.
func (t *turnLog) agent(text string) {
	t.lastAgent = t.take()
	t.emit(t.lastAgent, events.RoleAgent, text)
}

// correct re-emits the newest agent turn with what was actually said before the cut-off.
func (t *turnLog) correct(text string) {
	if t.lastAgent == 0 {
		return
	}
	t.emit(t.lastAgent, events.RoleAgent, text)
}

func (t *turnLog) take() int {
	seq := t.next
	t.next++
	return seq
}

func (t *turnLog) emit(seq int, role, text string) {
	t.sink(events.Turn{Room: t.room, Seq: seq, Role: role, Text: text, At: t.now()})
}
