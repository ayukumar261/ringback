package session

import (
	"encoding/binary"
	"math"
	"testing"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
	"github.com/ayukumar261/ringback/apps/worker/internal/events"
)

func speechRoom() *fakeRoom {
	rm := newFakeRoom()
	rm.started = time.UnixMilli(1753795200000)
	rm.detector = audio.NewSpeechDetector(nil)
	return rm
}

func speechTone(amplitude float64) []byte {
	pcm := make([]byte, audio.FrameBytes)
	for i := range audio.FrameSamples {
		sample := int16(amplitude * math.Sin(2*math.Pi*500*float64(i)/audio.SampleRate))
		binary.LittleEndian.PutUint16(pcm[2*i:], uint16(sample))
	}
	return pcm
}

func recordCallerFrames(rm *fakeRoom, caller, agent []byte, n int) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	for range n {
		rm.detector.Record(caller, agent)
		rm.recorded += audio.FrameDuration
		rm.queued = max(0, rm.queued-audio.FrameDuration)
	}
}

func TestUserTurnJoinsOnlySpeechSincePreviousTranscript(t *testing.T) {
	rm := recordingRoom()
	applyEvent, got := timingDriver(t, rm)
	rm.speech = []audio.SpeechSegment{
		{Started: 100 * time.Millisecond, Ended: 200 * time.Millisecond},
		{Started: 300 * time.Millisecond, Ended: 500 * time.Millisecond},
	}
	applyEvent(agent.UserTurn{Text: "Hello, can you help?"})
	assertSpan(t, (*got)[0], rm.started.Add(100*time.Millisecond), rm.started.Add(500*time.Millisecond))
	if (*got)[0].Role != events.RoleUser || (*got)[0].Ended.Sub((*got)[0].Started) != 400*time.Millisecond {
		t.Fatalf("user turn = %+v", (*got)[0])
	}
	applyEvent(agent.UserTurn{Text: "A turn with no detected speech"})
	assertSpan(t, (*got)[1], time.Time{}, time.Time{})
	rm.speech = []audio.SpeechSegment{{Started: 700 * time.Millisecond, Ended: 800 * time.Millisecond}}
	applyEvent(agent.UserTurn{Text: "Next utterance"})
	assertSpan(t, (*got)[2], rm.started.Add(700*time.Millisecond), rm.started.Add(800*time.Millisecond))
}

func TestUserTurnUsesSpeechEdgesInsteadOfTranscriptArrival(t *testing.T) {
	rm := speechRoom()
	applyEvent, got := timingDriver(t, rm)
	recordCallerFrames(rm, nil, nil, 10)
	recordCallerFrames(rm, speechTone(5000), nil, 15)
	recordCallerFrames(rm, nil, nil, 100) // ASR arrives two seconds after speech stopped
	applyEvent(agent.UserTurn{Text: "What are your hours?"})
	assertSpan(t, (*got)[0], rm.started.Add(200*time.Millisecond), rm.started.Add(500*time.Millisecond))
	if rm.Recorded() != 2500*time.Millisecond {
		t.Fatal("test did not delay the transcript past the speech")
	}
}

func TestUserTurnClosesOpenSpeechAndDoesNotReuseIt(t *testing.T) {
	rm := speechRoom()
	applyEvent, got := timingDriver(t, rm)
	tone := speechTone(5000)
	recordCallerFrames(rm, tone, nil, 6)
	applyEvent(agent.UserTurn{Text: "First part"})
	assertSpan(t, (*got)[0], rm.started, rm.started.Add(120*time.Millisecond))
	recordCallerFrames(rm, tone, nil, 5)
	applyEvent(agent.UserTurn{Text: "Second part"})
	assertSpan(t, (*got)[1], rm.started.Add(120*time.Millisecond), rm.started.Add(220*time.Millisecond))
	applyEvent(agent.UserTurn{Text: "No new frames"})
	assertSpan(t, (*got)[2], time.Time{}, time.Time{})
}

func TestCallerBargeInStartsBeforeAgentEnds(t *testing.T) {
	rm := speechRoom()
	applyEvent, got := timingDriver(t, rm)
	agentTone := speechTone(3000)
	callerTone := speechTone(12000)
	recordCallerFrames(rm, nil, nil, 10)
	applyEvent(agent.AgentTurn{Text: "Let me explain", EventID: 1})
	applyEvent(agent.Audio{PCM: pcmFrames(50), EventID: 1})
	recordCallerFrames(rm, nil, agentTone, 5)
	recordCallerFrames(rm, callerTone, agentTone, 5)
	applyEvent(agent.Interruption{EventID: 2})
	applyEvent(agent.UserTurn{Text: "Stop"})
	var agentTurn, userTurn events.Turn
	for _, turn := range *got {
		if turn.Role == events.RoleAgent {
			agentTurn = turn
		} else if turn.Role == events.RoleUser {
			userTurn = turn
		}
	}
	assertSpan(t, agentTurn, rm.started.Add(200*time.Millisecond), rm.started.Add(400*time.Millisecond))
	assertSpan(t, userTurn, rm.started.Add(300*time.Millisecond), rm.started.Add(400*time.Millisecond))
	if !userTurn.Started.Before(agentTurn.Ended) {
		t.Fatalf("caller start %v does not overlap agent end %v", userTurn.Started, agentTurn.Ended)
	}
}

func TestEchoOnlyUserTranscriptHasNoSpan(t *testing.T) {
	rm := speechRoom()
	applyEvent, got := timingDriver(t, rm)
	tone := speechTone(5000)
	recordCallerFrames(rm, tone, tone, 20)
	applyEvent(agent.UserTurn{Text: "Text still reaches the transcript"})
	if len(*got) != 1 || (*got)[0].Text != "Text still reaches the transcript" {
		t.Fatalf("missing user transcript: %v", *got)
	}
	assertSpan(t, (*got)[0], time.Time{}, time.Time{})
}

func TestUserTurnAfterHangupKeepsRecordedSpeech(t *testing.T) {
	rm := speechRoom()
	recordCallerFrames(rm, speechTone(5000), nil, 5)
	rm.kill(nil)
	turns, got := newTestTurnLog("call-a")
	err := apply(agent.UserTurn{Text: "Bye"}, newFakeConv(), rm, turns, &agentPlayout{turns: turns}, true, instant, discard)
	if err != nil {
		t.Fatal(err)
	}
	assertSpan(t, (*got)[0], rm.started, rm.started.Add(100*time.Millisecond))
}
