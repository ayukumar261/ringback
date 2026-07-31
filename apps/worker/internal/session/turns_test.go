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
	tl.agent("Hello!")
	tl.caller("Hi, I need help.")
	tl.agent("Sure, with what?")

	want := []events.Turn{
		{Room: "call-a", Seq: 1, Role: events.RoleAgent, Text: "Hello!", At: time.UnixMilli(1753795200000)},
		{Room: "call-a", Seq: 2, Role: events.RoleCaller, Text: "Hi, I need help.", At: time.UnixMilli(1753795200000)},
		{Room: "call-a", Seq: 3, Role: events.RoleAgent, Text: "Sure, with what?", At: time.UnixMilli(1753795200000)},
	}
	if !slices.Equal(*turns, want) {
		t.Fatalf("turns = %v, want %v", *turns, want)
	}
}

func TestTurnLogCorrectionReemitsNewestAgentSeq(t *testing.T) {
	tl, turns := newTestTurnLog("call-a")
	tl.agent("Let me read you the full terms and cond-")
	tl.correct("Let me read")
	tl.caller("No thanks.")

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
