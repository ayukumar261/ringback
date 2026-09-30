package session

import (
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
)

// agentPlayout pairs a response's text with the audio queued for it. Text and
// audio may arrive in either order; the first audio chunk fixes the start.
type agentPlayout struct {
	turns   *turnLog
	active  bool
	eventID int
	seq     int
	started time.Time
	ended   time.Time
}

func (p *agentPlayout) text(e agent.AgentTurn) {
	// An interruption can finish audio before its transcript arrives.
	if p.seq == 0 && !p.started.IsZero() && p.matches(e.EventID) {
		p.seq = p.turns.agent(e.Text, p.started)
		if !p.active {
			p.turns.end(p.seq, p.ended)
		}
		return
	}
	if !p.active || !p.matches(e.EventID) || p.seq != 0 {
		p.finish(time.Time{})
		*p = agentPlayout{turns: p.turns, active: true, eventID: e.EventID}
	}
	p.seq = p.turns.agent(e.Text, p.started)
}

func (p *agentPlayout) audio(eventID int, started, ended time.Time) {
	if !p.active || !p.matches(eventID) {
		p.finish(time.Time{})
		*p = agentPlayout{turns: p.turns, active: true, eventID: eventID}
	}
	if p.started.IsZero() {
		p.started = started
		p.turns.start(p.seq, started)
	}
	p.ended = ended
}

// Some provider frames omit the ID; in that case use the current response.
func (p *agentPlayout) matches(eventID int) bool {
	return p.eventID == eventID || p.eventID == 0 || eventID == 0
}

// finish uses the last chunk's playout end, capped by the recording position
// when an interruption or hangup discarded audio that was still queued.
func (p *agentPlayout) finish(cutoff time.Time) {
	if !p.active {
		if !cutoff.IsZero() {
			p.turns.end(p.turns.lastAgent.Seq, cutoff)
		}
		return
	}
	if !cutoff.IsZero() && cutoff.Before(p.ended) {
		p.ended = cutoff
	}
	p.turns.end(p.seq, p.ended)
	p.active = false
}

// recordingPosition is an instant in the saved audio, zero with no recording.
func recordingPosition(rm roomHandle) time.Time {
	started := rm.StartedAt()
	if started.IsZero() {
		return time.Time{}
	}
	return started.Add(rm.Recorded())
}

// playoutPosition is where a newly queued chunk would begin in the recording.
func playoutPosition(rm roomHandle) time.Time {
	position := recordingPosition(rm)
	if position.IsZero() {
		return time.Time{}
	}
	return position.Add(rm.Buffered())
}
