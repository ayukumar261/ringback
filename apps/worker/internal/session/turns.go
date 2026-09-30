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
	lastAgent events.Turn // retained so timing updates and corrections keep the same seq and text
}

// newTurnLog builds a turnLog for room whose turns land on sink.
func newTurnLog(room string, sink func(events.Turn)) *turnLog {
	return &turnLog{room: room, sink: sink, now: time.Now, next: 1}
}

// user records what the person on the other end of the call said.
func (t *turnLog) user(text string, started, ended time.Time) {
	turn := t.turn(events.RoleUser, text, started)
	turn.Ended = ended
	t.emit(turn)
}

// agent records what the agent said.
func (t *turnLog) agent(text string, started time.Time) int {
	t.lastAgent = t.turn(events.RoleAgent, text, started)
	t.emit(t.lastAgent)
	return t.lastAgent.Seq
}

// tool records something the agent did on the call rather than said.
func (t *turnLog) tool(text string, started time.Time) events.Turn {
	turn := t.turn(events.RoleTool, text, started)
	t.emit(turn)
	return turn
}

// start attaches the first audio position when text arrived before its audio.
func (t *turnLog) start(seq int, at time.Time) {
	if seq == 0 || seq != t.lastAgent.Seq || at.IsZero() || !t.lastAgent.Started.IsZero() {
		return
	}
	t.lastAgent.Started = at
	t.emit(t.lastAgent)
}

// end completes the newest agent span, or shortens it when queued audio was cut off.
func (t *turnLog) end(seq int, at time.Time) {
	if seq == 0 || seq != t.lastAgent.Seq || t.lastAgent.Started.IsZero() || at.IsZero() {
		return
	}
	if at.Before(t.lastAgent.Started) {
		at = t.lastAgent.Started
	}
	if !t.lastAgent.Ended.IsZero() && !at.Before(t.lastAgent.Ended) {
		return
	}
	t.lastAgent.Ended = at
	t.emit(t.lastAgent)
}

// endTool completes a press without changing which agent turn corrections target.
func (t *turnLog) endTool(turn events.Turn, at time.Time) {
	if turn.Started.IsZero() || at.IsZero() {
		return
	}
	if at.Before(turn.Started) {
		at = turn.Started
	}
	turn.Ended = at
	t.emit(turn)
}

// correct re-emits the newest agent turn with what was actually said before the cut-off.
func (t *turnLog) correct(text string) {
	if t.lastAgent.Seq == 0 {
		return
	}
	t.lastAgent.Text = text
	t.emit(t.lastAgent)
}

func (t *turnLog) take() int {
	seq := t.next
	t.next++
	return seq
}

func (t *turnLog) turn(role, text string, started time.Time) events.Turn {
	return events.Turn{Room: t.room, Seq: t.take(), Role: role, Text: text, At: t.now(), Started: started}
}

func (t *turnLog) emit(turn events.Turn) {
	t.sink(turn)
}
