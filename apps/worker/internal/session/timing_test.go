package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
	"github.com/ayukumar261/ringback/apps/worker/internal/events"
)

func recordingRoom() *fakeRoom {
	rm := newFakeRoom()
	rm.started = time.UnixMilli(1753795200000)
	rm.recorded = time.Second
	return rm
}

func pcmFrames(n int) []byte { return make([]byte, n*audio.FrameBytes) }

// timingDriver applies events while the test controls the recording's progress.
func timingDriver(t *testing.T, rm *fakeRoom) (func(agent.Event), *[]events.Turn) {
	t.Helper()
	turns, got := newTestTurnLog("call-a")
	playout := &agentPlayout{turns: turns}
	conv := newFakeConv()
	return func(ev agent.Event) {
		t.Helper()
		if err := apply(ev, conv, rm, turns, playout, false, instant, discard); err != nil {
			t.Fatal(err)
		}
	}, got
}

func assertSpan(t *testing.T, turn events.Turn, start, end time.Time) {
	t.Helper()
	if !turn.Started.Equal(start) || !turn.Ended.Equal(end) {
		t.Fatalf("turn %d span = %v to %v, want %v to %v", turn.Seq, turn.Started, turn.Ended, start, end)
	}
}

func TestAgentSpanStartsAtFirstAudioAndEndsAtLastChunk(t *testing.T) {
	rm := recordingRoom()
	rm.queued = 100 * time.Millisecond
	applyEvent, got := timingDriver(t, rm)
	applyEvent(agent.AgentTurn{Text: "Hello there", EventID: 1})
	assertSpan(t, (*got)[0], time.Time{}, time.Time{})
	rm.advance(40 * time.Millisecond)
	applyEvent(agent.Audio{PCM: pcmFrames(10), EventID: 1})
	start := rm.started.Add(1100 * time.Millisecond)
	assertSpan(t, (*got)[1], start, time.Time{})
	rm.advance(60 * time.Millisecond)
	applyEvent(agent.Audio{PCM: pcmFrames(5), EventID: 1})
	applyEvent(agent.UserTurn{Text: "Thanks"})
	if len(*got) != 4 {
		t.Fatalf("turns = %v, want text, start, end, and user", *got)
	}
	assertSpan(t, (*got)[2], start, start.Add(300*time.Millisecond))
	if (*got)[2].Seq != 1 || (*got)[2].Text != "Hello there" {
		t.Fatalf("end changed the transcript turn: %+v", (*got)[2])
	}
}

func TestAgentAudioBeforeTextKeepsItsOriginalStart(t *testing.T) {
	rm := recordingRoom()
	applyEvent, got := timingDriver(t, rm)
	applyEvent(agent.Audio{PCM: pcmFrames(10), EventID: 7})
	rm.advance(80 * time.Millisecond)
	applyEvent(agent.AgentTurn{Text: "Hello", EventID: 7})
	assertSpan(t, (*got)[0], rm.started.Add(time.Second), time.Time{})
	applyEvent(agent.AgentTurn{Text: "Next", EventID: 8})
	assertSpan(t, (*got)[1], rm.started.Add(time.Second), rm.started.Add(1200*time.Millisecond))
	assertSpan(t, (*got)[2], time.Time{}, time.Time{})
}

func TestAgentTextAfterInterruptionKeepsTheHeardSpan(t *testing.T) {
	rm := recordingRoom()
	applyEvent, got := timingDriver(t, rm)
	applyEvent(agent.Audio{PCM: pcmFrames(10), EventID: 7})
	rm.advance(80 * time.Millisecond)
	applyEvent(agent.Interruption{EventID: 8})
	applyEvent(agent.AgentTurn{Text: "Hello there", EventID: 7})
	applyEvent(agent.Correction{Corrected: "Hello", EventID: 7})
	last := (*got)[len(*got)-1]
	assertSpan(t, last, rm.started.Add(time.Second), rm.started.Add(1080*time.Millisecond))
	if last.Text != "Hello" {
		t.Fatalf("late transcript = %+v", last)
	}
}

func TestAgentSpanEndsAtInterruptionAndSurvivesCorrection(t *testing.T) {
	for _, userFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "interruption first", true: "user transcript first"}[userFirst], func(t *testing.T) {
			rm := recordingRoom()
			applyEvent, got := timingDriver(t, rm)
			applyEvent(agent.AgentTurn{Text: "Hello there", EventID: 1})
			applyEvent(agent.Audio{PCM: pcmFrames(20), EventID: 1})
			rm.advance(80 * time.Millisecond)
			if userFirst {
				applyEvent(agent.UserTurn{Text: "Stop"})
			}
			applyEvent(agent.Interruption{EventID: 2})
			applyEvent(agent.Correction{Corrected: "Hello", EventID: 1})
			last := (*got)[len(*got)-1]
			assertSpan(t, last, rm.started.Add(time.Second), rm.started.Add(1080*time.Millisecond))
			if last.Seq != 1 || last.Text != "Hello" || rm.Buffered() != 0 {
				t.Fatalf("interrupted turn = %+v, buffered = %v", last, rm.Buffered())
			}
		})
	}
}

func TestTurnsWithoutAudioHaveNoSpan(t *testing.T) {
	for _, recording := range []bool{false, true} {
		t.Run(map[bool]string{false: "recording disabled", true: "text only"}[recording], func(t *testing.T) {
			rm, conv := newFakeRoom(), newFakeConv()
			if recording {
				rm = recordingRoom()
			}
			conv.events <- agent.AgentTurn{Text: "Hello", EventID: 1}
			if !recording {
				conv.events <- agent.Audio{PCM: pcmFrames(5), EventID: 1}
			}
			conv.queue(agent.UserTurn{Text: "Hi"})
			turns, got := newTestTurnLog("call-a")
			if err := downlink(conv, rm, turns, instant, discard); err != nil {
				t.Fatal(err)
			}
			if len(*got) != 2 {
				t.Fatalf("turns = %v, want only agent and user text", *got)
			}
			for _, turn := range *got {
				assertSpan(t, turn, time.Time{}, time.Time{})
			}
		})
	}
}

func TestDownlinkFinalizesLastAgentAtPlayoutEnd(t *testing.T) {
	rm, conv := recordingRoom(), newFakeConv()
	conv.queue(agent.AgentTurn{Text: "Bye", EventID: 1}, agent.Audio{PCM: pcmFrames(5), EventID: 1})
	turns, got := newTestTurnLog("call-a")
	if err := downlink(conv, rm, turns, instant, discard); err != nil {
		t.Fatal(err)
	}
	assertSpan(t, (*got)[len(*got)-1], rm.started.Add(time.Second), rm.started.Add(1100*time.Millisecond))
}

func TestBridgeFinalSpanMatchesDrainedOrAbortedAudio(t *testing.T) {
	for _, abort := range []bool{false, true} {
		t.Run(map[bool]string{false: "clean drain", true: "transport error"}[abort], func(t *testing.T) {
			rm, conv := recordingRoom(), newFakeConv()
			seen := make(chan events.Turn, 10)
			turns := newTurnLog("call-a", func(turn events.Turn) { seen <- turn })
			done := make(chan error, 1)
			go func() { done <- bridge(context.Background(), rm, conv, turns, instant, discard) }()
			conv.events <- agent.AgentTurn{Text: "Bye", EventID: 1}
			conv.events <- agent.Audio{PCM: pcmFrames(5), EventID: 1}
			for range 2 { // Wait for text and its first audio position.
				select {
				case <-seen:
				case <-time.After(2 * time.Second):
					t.Fatal("missing initial turn")
				}
			}
			rm.advance(40 * time.Millisecond)
			if abort {
				conv.finish(errors.New("connection lost"))
			} else {
				conv.finish(nil)
				waitFor(t, func() bool { _, n := rm.snapshot(); return n > 2 })
				rm.advance(60 * time.Millisecond)
			}
			select {
			case err := <-done:
				if (err != nil) != abort {
					t.Fatalf("bridge error = %v, abort = %v", err, abort)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("bridge did not finish")
			}
			end := 1100 * time.Millisecond
			if abort {
				end = 1040 * time.Millisecond
			}
			assertSpan(t, turns.lastAgent, rm.started.Add(time.Second), rm.started.Add(end))
		})
	}
}

func TestBridgeHangupClipsAgentSpanAndKeepsLateCorrection(t *testing.T) {
	rm, conv, clk := recordingRoom(), newFakeConv(), newFakeClock()
	seen := make(chan events.Turn, 10)
	turns := newTurnLog("call-a", func(turn events.Turn) { seen <- turn })
	done := make(chan error, 1)
	go func() { done <- bridge(context.Background(), rm, conv, turns, clk.after, discard) }()
	conv.events <- agent.AgentTurn{Text: "Goodbye everyone", EventID: 1}
	conv.events <- agent.Audio{PCM: pcmFrames(25), EventID: 1}
	readTurn := func() events.Turn {
		t.Helper()
		select {
		case turn := <-seen:
			return turn
		case <-time.After(2 * time.Second):
			t.Fatal("missing transcript event")
			return events.Turn{}
		}
	}
	readTurn() // text
	readTurn() // start
	rm.advance(100 * time.Millisecond)
	rm.kill(nil)
	waitFor(t, func() bool { return len(clk.asked()) == 1 })
	assertSpan(t, readTurn(), rm.started.Add(time.Second), rm.started.Add(1100*time.Millisecond))
	conv.events <- agent.Audio{PCM: pcmFrames(5), EventID: 1} // ignored during the grace
	conv.events <- agent.Correction{Corrected: "Goodbye", EventID: 1}
	corrected := readTurn()
	assertSpan(t, corrected, rm.started.Add(time.Second), rm.started.Add(1100*time.Millisecond))
	if corrected.Text != "Goodbye" {
		t.Fatalf("correction = %+v", corrected)
	}
	clk.fire <- time.Time{}
	awaitAnswer(t, done)
}

func TestToolSpanFollowsRecordingDuringHold(t *testing.T) {
	for _, hangup := range []bool{false, true} {
		t.Run(map[bool]string{false: "tones finish", true: "hangup during tones"}[hangup], func(t *testing.T) {
			rm, conv, clk := recordingRoom(), newFakeConv(), newFakeClock()
			turns, got := newTestTurnLog("call-a")
			done := startAnswer(rm, conv, turns, agent.Tool{ID: "tool-1", Name: "send_dtmf", Params: []byte(`{"digits":"1"}`)}, clk.after)
			waitFor(t, func() bool { return len(clk.asked()) == 1 })
			if len(*got) != 1 {
				t.Fatalf("tool text should be visible before the hold: %v", *got)
			}
			assertSpan(t, (*got)[0], rm.started.Add(time.Second), time.Time{})
			elapsed := 500 * time.Millisecond
			if hangup {
				elapsed = 100 * time.Millisecond
			}
			rm.advance(elapsed)
			if hangup {
				rm.kill(nil)
			} else {
				clk.fire <- time.Time{}
			}
			awaitAnswer(t, done)
			if len(*got) != 2 || (*got)[0].Seq != (*got)[1].Seq || (*got)[1].Role != events.RoleTool {
				t.Fatalf("tool updates = %v", *got)
			}
			assertSpan(t, (*got)[1], rm.started.Add(time.Second), rm.started.Add(time.Second+elapsed))
		})
	}
}

func TestToolSpanExcludesDelayPublishingItsText(t *testing.T) {
	rm, conv := recordingRoom(), newFakeConv()
	var got []events.Turn
	turns := newTurnLog("call-a", func(turn events.Turn) {
		got = append(got, turn)
		if turn.Ended.IsZero() {
			rm.advance(time.Second) // simulate a slow initial Redis publish
		}
	})
	after := func(d time.Duration) <-chan time.Time {
		rm.advance(d)
		return instant(d)
	}
	if err := answerTool(conv, rm, turns, agent.Tool{ID: "tool-1", Name: "send_dtmf", Params: []byte(`{"digits":"1"}`)}, after, discard); err != nil {
		t.Fatal(err)
	}
	assertSpan(t, got[len(got)-1], rm.started.Add(time.Second), rm.started.Add(1500*time.Millisecond))
}
