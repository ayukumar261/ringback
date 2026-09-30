package session

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/agent"
	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
	"github.com/ayukumar261/ringback/apps/worker/internal/events"
	"github.com/ayukumar261/ringback/apps/worker/internal/room"
	"github.com/ayukumar261/ringback/apps/worker/internal/speech"
	"github.com/ayukumar261/ringback/apps/worker/internal/wav"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
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

func speechRoom() *fakeRoom {
	rm := newFakeRoom()
	rm.started = time.UnixMilli(1753795200000)
	rm.detector = speech.NewDetector(&fakeVoice{})
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
	rm.speech = []speech.Segment{
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
	rm.speech = []speech.Segment{{Started: 700 * time.Millisecond, Ended: 800 * time.Millisecond}}
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
	assertSpan(t, (*got)[0], rm.started.Add(168*time.Millisecond), rm.started.Add(500*time.Millisecond))
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
	assertSpan(t, userTurn, rm.started.Add(268*time.Millisecond), rm.started.Add(400*time.Millisecond))
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

// Deterministic classification for recording-clock tests; acoustic accuracy is
// covered by the real speech fixtures in the speech package.
type fakeVoice struct{ position time.Duration }

func (v *fakeVoice) Process(caller, agent []byte) ([]speech.VoiceFrame, error) {
	p := 0.0
	// Identical channels represent an explicitly annotated echo-only interval in
	// these clock tests. This is not an acoustic echo detector.
	if !bytes.Equal(caller, agent) {
		for _, b := range caller {
			if b != 0 {
				p = 1
				break
			}
		}
	}
	f := speech.VoiceFrame{Started: v.position, Ended: v.position + audio.FrameDuration, Probability: p}
	v.position += audio.FrameDuration
	return []speech.VoiceFrame{f}, nil
}
func (*fakeVoice) Flush() ([]speech.VoiceFrame, error) { return nil, nil }
func (*fakeVoice) Close()                              {}

// A controlled call through a real LiveKit server, Opus/RTP, recording, detector,
// and session turn handling. No phone recipient or hosted voice agent is used.
// Start LiveKit --dev and set VAD_LIVEKIT_URL to run this timing regression.
func TestLiveSpeechInterruption(t *testing.T) {
	url := os.Getenv("VAD_LIVEKIT_URL")
	if url == "" {
		t.Skip("set VAD_LIVEKIT_URL for the real-media call test")
	}
	dir := t.TempDir()
	name := fmt.Sprintf("call-speech-test-%d", time.Now().Unix())
	rm, err := room.Join(context.Background(), room.Opts{URL: url, APIKey: "devkey", APISecret: "secret", RoomName: name, AudioDir: dir, Log: discard})
	if err != nil {
		t.Fatal(err)
	}
	defer rm.Close()
	caller, err := lksdk.ConnectToRoom(url, lksdk.ConnectInfo{APIKey: "devkey", APISecret: "secret", RoomName: name, ParticipantIdentity: "test-caller"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer caller.Disconnect()
	track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = caller.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "caller", Source: livekit.TrackSource_MICROPHONE}); err != nil {
		t.Fatal(err)
	}
	go func() {
		for range rm.CallerPCM() {
		}
	}()
	load := func(name string, gain float64) []byte {
		t.Helper()
		pcm, rate, err := wav.Read("../speech/testdata/" + name + ".wav")
		if err != nil || rate != 16000 {
			t.Fatal(err, rate)
		}
		out := make([]byte, len(pcm)*3)
		for i := 0; i < len(pcm); i += 2 {
			v := int16(binary.LittleEndian.Uint16(pcm[i:]))
			for j := range 3 {
				binary.LittleEndian.PutUint16(out[3*i+2*j:], uint16(int16(float64(v)*gain)))
			}
		}
		return out
	}
	callerPCM, playback := load("caller", .1), load("agent", 1)
	encoder, err := audio.NewEncoder()
	if err != nil {
		t.Fatal(err)
	}
	turns, got := newTestTurnLog(name)
	turns.now = time.Now
	playout := &agentPlayout{turns: turns}
	conv := newFakeConv()
	applyEvent := func(ev agent.Event, ended bool) {
		t.Helper()
		if err := apply(ev, conv, rm, turns, playout, ended, instant, discard); err != nil {
			t.Fatal(err)
		}
	}
	// Establish the media stream before measuring fixture-relative times.
	ticker := time.NewTicker(audio.FrameDuration)
	defer ticker.Stop()
	silence := make([]byte, audio.FrameBytes)
	for range 25 {
		<-ticker.C
		packet, err := encoder.Encode(silence)
		if err != nil {
			t.Fatal(err)
		}
		if err = track.WriteSample(media.Sample{Data: packet, Duration: audio.FrameDuration}, nil); err != nil {
			t.Fatal(err)
		}
	}
	start := rm.Recorded()
	applyEvent(agent.AgentTurn{Text: "Recorded reference speech", EventID: 1}, false)
	applyEvent(agent.Audio{PCM: playback, EventID: 1}, false)
	for i := 0; i < len(callerPCM); i += audio.FrameBytes {
		<-ticker.C
		packet, err := encoder.Encode(callerPCM[i : i+audio.FrameBytes])
		if err != nil {
			t.Fatal(err)
		}
		if err = track.WriteSample(media.Sample{Data: packet, Duration: audio.FrameDuration}, nil); err != nil {
			t.Fatal(err)
		}
		if i/audio.FrameBytes == 200 {
			applyEvent(agent.Interruption{EventID: 2}, false)
		}
	}
	rm.Close()
	applyEvent(agent.UserTurn{Text: "Recorded caller speech; final transcript after hangup"}, true)
	var userTurn, agentTurn events.Turn
	for _, turn := range *got {
		if turn.Role == events.RoleUser {
			userTurn = turn
		} else {
			agentTurn = turn
		}
	}
	if userTurn.Started.IsZero() || !userTurn.Started.Before(agentTurn.Ended) {
		t.Fatalf("missing overlap: user=%+v agent=%+v", userTurn, agentTurn)
	}
	wantStart, wantEnd := rm.StartedAt().Add(start+3200*time.Millisecond), rm.StartedAt().Add(start+6800*time.Millisecond)
	if userTurn.Started.Sub(wantStart).Abs() > 300*time.Millisecond || userTurn.Ended.Sub(wantEnd).Abs() > 300*time.Millisecond {
		t.Fatalf("spans drifted from transmitted speech: user=%+v want=%v..%v", userTurn, wantStart, wantEnd)
	}
	data, err := os.ReadFile(filepath.Join(dir, name+".wav"))
	if err != nil {
		t.Fatal(err)
	}
	samples := (len(data) - 44) / 4
	if time.Duration(samples)*time.Second/audio.SampleRate != rm.Recorded() {
		t.Fatal("WAV and recording clock differ")
	}
	// Replay the saved samples, independently of RTP arrival and actor timing.
	detector := speech.NewDetector(nil)
	for offset := 44; offset < len(data); offset += audio.FrameBytes * 2 {
		left, right := make([]byte, audio.FrameBytes), make([]byte, audio.FrameBytes)
		for sample := range audio.FrameSamples {
			copy(left[2*sample:], data[offset+4*sample:offset+4*sample+2])
			copy(right[2*sample:], data[offset+4*sample+2:offset+4*sample+4])
		}
		detector.Record(left, right)
	}
	detector.Finish()
	if detector.Err() != nil {
		t.Fatal(detector.Err())
	}
	spans := detector.Take()
	if len(spans) == 0 || !rm.StartedAt().Add(spans[0].Started).Equal(userTurn.Started) || !rm.StartedAt().Add(spans[len(spans)-1].Ended).Equal(userTurn.Ended) {
		t.Fatalf("saved WAV disagrees with live span: %v vs %+v", spans, userTurn)
	}
}
