package session

import (
	"slices"
	"testing"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/events"
)

// newTestTurnLog builds a turnLog with a fixed clock whose turns land in the returned slice.
func newTestTurnLog(room string) (*turnLog, *[]events.Turn) {
	turns := &[]events.Turn{}
	tl := newTurnLog(room, func(t events.Turn) { *turns = append(*turns, t) })
	tl.now = func() time.Time { return time.UnixMilli(1753795200000) }
	return tl, turns
}

func TestTurnLogNumbersRolesInOrder(t *testing.T) {
	tl, turns := newTestTurnLog("call-a")
	tl.agent("Hello!", time.Time{})
	tl.user("Hi, I need help.", time.Time{}, time.Time{})
	tl.agent("Sure, with what?", time.Time{})

	want := []events.Turn{
		{Room: "call-a", Seq: 1, Role: events.RoleAgent, Text: "Hello!", At: time.UnixMilli(1753795200000)},
		{Room: "call-a", Seq: 2, Role: events.RoleUser, Text: "Hi, I need help.", At: time.UnixMilli(1753795200000)},
		{Room: "call-a", Seq: 3, Role: events.RoleAgent, Text: "Sure, with what?", At: time.UnixMilli(1753795200000)},
	}
	if !slices.Equal(*turns, want) {
		t.Fatalf("turns = %v, want %v", *turns, want)
	}
}

func TestTurnLogCorrectionReemitsNewestAgentSeq(t *testing.T) {
	tl, turns := newTestTurnLog("call-a")
	tl.agent("Let me read you the full terms and cond-", time.Time{})
	tl.correct("Let me read")
	tl.user("No thanks.", time.Time{}, time.Time{})

	seqs := make([]int, 0, len(*turns))
	for _, turn := range *turns {
		seqs = append(seqs, turn.Seq)
	}
	if want := []int{1, 1, 2}; !slices.Equal(seqs, want) {
		t.Fatalf("seqs = %v, want %v", seqs, want)
	}
	if (*turns)[1].Text != "Let me read" || (*turns)[1].Role != events.RoleAgent {
		t.Fatalf("correction = %+v, want the corrected agent text", (*turns)[1])
	}
}

func TestTurnLogCorrectionBeforeAnyAgentTurnDropped(t *testing.T) {
	tl, turns := newTestTurnLog("call-a")
	tl.correct("stray")
	if len(*turns) != 0 {
		t.Fatalf("turns = %v, want none", *turns)
	}
}

func TestTurnLogCorrectionAfterToolTurnRewritesAgentTurn(t *testing.T) {
	tl, turns := newTestTurnLog("call-a")
	tl.agent("Press one for-", time.Time{})
	tl.tool("pressed 1", time.Time{})
	tl.correct("Press one")

	want := []events.Turn{
		{Room: "call-a", Seq: 1, Role: events.RoleAgent, Text: "Press one for-", At: time.UnixMilli(1753795200000)},
		{Room: "call-a", Seq: 2, Role: events.RoleTool, Text: "pressed 1", At: time.UnixMilli(1753795200000)},
		{Room: "call-a", Seq: 1, Role: events.RoleAgent, Text: "Press one", At: time.UnixMilli(1753795200000)},
	}
	if !slices.Equal(*turns, want) {
		t.Fatalf("turns = %v, want %v", *turns, want)
	}
}

func TestTurnLogTimingUpdatesPreserveTextAndCorrection(t *testing.T) {
	tl, got := newTestTurnLog("call-a")
	start := time.UnixMilli(1753795201000)
	seq := tl.agent("Hello there", time.Time{})
	tl.start(seq, start)
	tl.correct("Hello")
	tl.now = func() time.Time { return start.Add(time.Minute) }
	tl.end(seq, start.Add(100*time.Millisecond))
	tail := (*got)[len(*got)-1]
	if tail.Seq != seq || tail.Text != "Hello" || !tail.Started.Equal(start) || !tail.Ended.Equal(start.Add(100*time.Millisecond)) {
		t.Fatalf("completed turn = %+v", tail)
	}
	if !tail.At.Equal((*got)[0].At) {
		t.Fatalf("timing update changed transcript arrival from %v to %v", (*got)[0].At, tail.At)
	}
	tl.tool("pressed 1", start)
	tl.correct("Hel-")
	corrected := (*got)[len(*got)-1]
	if corrected.Seq != seq || corrected.Text != "Hel-" || corrected.Started != tail.Started || corrected.Ended != tail.Ended {
		t.Fatalf("correction lost the agent span: %+v", corrected)
	}
}

func TestTurnLogEndOnlyUpdatesNewestAgent(t *testing.T) {
	tl, got := newTestTurnLog("call-a")
	start := time.UnixMilli(1753795201000)
	old := tl.agent("First", start)
	seq := tl.agent("Second", start.Add(time.Second))
	tl.end(old, start.Add(100*time.Millisecond))
	if len(*got) != 2 {
		t.Fatalf("stale end re-emitted a turn: %v", *got)
	}
	tl.end(seq, start.Add(1500*time.Millisecond))
	tl.end(seq, start.Add(2*time.Second))
	if len(*got) != 3 {
		t.Fatalf("end extended an already finished span: %v", *got)
	}
	tl.end(seq, start.Add(1200*time.Millisecond))
	if last := (*got)[len(*got)-1]; !last.Ended.Equal(start.Add(1200 * time.Millisecond)) {
		t.Fatalf("hangup did not shorten the span: %+v", last)
	}
}
