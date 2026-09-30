package audio

import (
	"bytes"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/wav"
)

func recordSpeechFrames(d *SpeechDetector, caller, agent []byte, n int) {
	for range n {
		d.Record(caller, agent)
	}
}

func TestSpeechDetectorMatchesWAVBurstEdges(t *testing.T) {
	// Two bursts separated by enough quiet to close the first segment.
	var pcm []byte
	pcm = append(pcm, make([]byte, 10*FrameBytes)...)
	pcm = append(pcm, bytes.Join(sineFrames(500, 5000, 15), nil)...)
	pcm = append(pcm, make([]byte, 20*FrameBytes)...)
	pcm = append(pcm, bytes.Join(sineFrames(500, 5000, 8), nil)...)
	pcm = append(pcm, make([]byte, 12*FrameBytes)...)
	path := filepath.Join(t.TempDir(), "caller.wav")
	if err := wav.Write(path, pcm, SampleRate); err != nil {
		t.Fatal(err)
	}
	samples, rate, err := wav.Read(path)
	if err != nil || rate != SampleRate {
		t.Fatalf("read WAV: rate=%d err=%v", rate, err)
	}
	d := NewSpeechDetector(nil)
	for offset := 0; offset < len(samples); offset += FrameBytes {
		d.Record(samples[offset:offset+FrameBytes], nil)
	}
	want := []SpeechSegment{
		{Started: 200 * time.Millisecond, Ended: 500 * time.Millisecond},
		{Started: 900 * time.Millisecond, Ended: 1060 * time.Millisecond},
	}
	if got := d.Take(); !slices.Equal(got, want) {
		t.Fatalf("speech = %v, want WAV edges %v", got, want)
	}
	if got := d.Take(); len(got) != 0 {
		t.Fatalf("consumed segments repeated: %v", got)
	}
}

func TestSpeechDetectorIgnoresSilenceAndShortClicks(t *testing.T) {
	d := NewSpeechDetector(nil)
	tone := sineFrames(500, 5000, 1)[0]
	for range 10 {
		recordSpeechFrames(d, nil, nil, 15)
		recordSpeechFrames(d, tone, nil, 2)
	}
	recordSpeechFrames(d, nil, nil, 15)
	if got := d.Take(); len(got) != 0 {
		t.Fatalf("silence and 40 ms clicks opened speech: %v", got)
	}
}

func TestSpeechDetectorJoinsShortPausesAndBackdatesEnd(t *testing.T) {
	d := NewSpeechDetector(nil)
	tone := sineFrames(500, 5000, 1)[0]
	recordSpeechFrames(d, tone, nil, 5)
	recordSpeechFrames(d, nil, nil, 5) // a 100 ms pause stays inside the utterance
	recordSpeechFrames(d, tone, nil, 5)
	recordSpeechFrames(d, nil, nil, 10)
	want := []SpeechSegment{{Started: 0, Ended: 300 * time.Millisecond}}
	if got := d.Take(); !slices.Equal(got, want) {
		t.Fatalf("speech = %v, want %v", got, want)
	}
}

func TestSpeechDetectorClosesOpenSpeechAtTranscriptAndStartsFresh(t *testing.T) {
	d := NewSpeechDetector(nil)
	tone := sineFrames(500, 5000, 1)[0]
	recordSpeechFrames(d, tone, nil, 5)
	recordSpeechFrames(d, nil, nil, 2) // not enough quiet to close naturally yet
	want := []SpeechSegment{{Started: 0, Ended: 140 * time.Millisecond}}
	if got := d.Take(); !slices.Equal(got, want) {
		t.Fatalf("open speech = %v, want current position %v", got, want)
	}
	recordSpeechFrames(d, tone, nil, 5)
	want = []SpeechSegment{{Started: 140 * time.Millisecond, Ended: 240 * time.Millisecond}}
	if got := d.Take(); !slices.Equal(got, want) {
		t.Fatalf("next speech = %v, want %v", got, want)
	}
}

func TestSpeechDetectorDoesNotReuseUnconfirmedOnset(t *testing.T) {
	d := NewSpeechDetector(nil)
	tone := sineFrames(500, 5000, 1)[0]
	recordSpeechFrames(d, tone, nil, 2)
	if got := d.Take(); len(got) != 0 {
		t.Fatalf("unconfirmed speech = %v", got)
	}
	recordSpeechFrames(d, tone, nil, 3)
	want := []SpeechSegment{{Started: 40 * time.Millisecond, Ended: 100 * time.Millisecond}}
	if got := d.Take(); !slices.Equal(got, want) {
		t.Fatalf("speech crossed the previous transcript: %v", got)
	}
}

func TestSpeechDetectorDiscountsAgentEcho(t *testing.T) {
	agent := sineFrames(500, 4000, 1)[0]
	for _, amplitude := range []int16{2000, 4000, 6000} {
		d := NewSpeechDetector(nil)
		caller := sineFrames(500, amplitude, 1)[0]
		recordSpeechFrames(d, caller, agent, 30)
		recordSpeechFrames(d, nil, nil, 10)
		if got := d.Take(); len(got) != 0 {
			t.Fatalf("caller amplitude %d against agent 4000 opened echo: %v", amplitude, got)
		}
	}
	d := NewSpeechDetector(nil)
	caller := sineFrames(700, 12000, 1)[0]
	recordSpeechFrames(d, caller, agent, 5)
	// Echo remaining after the caller stops must not keep the segment alive.
	recordSpeechFrames(d, agent, agent, 10)
	want := []SpeechSegment{{Started: 0, Ended: 100 * time.Millisecond}}
	if got := d.Take(); !slices.Equal(got, want) {
		t.Fatalf("louder caller barge-in = %v, want %v", got, want)
	}
}

func TestSpeechDetectorAdaptsToRisingBackgroundNoise(t *testing.T) {
	d := NewSpeechDetector(nil)
	// A gradually louder steady background remains below the learned threshold.
	for amplitude := int16(100); amplitude <= 1200; amplitude += 100 {
		recordSpeechFrames(d, sineFrames(500, amplitude, 1)[0], nil, 50)
	}
	if got := d.Take(); len(got) != 0 {
		t.Fatalf("background ramp opened speech: %v", got)
	}
	recordSpeechFrames(d, sineFrames(700, 8000, 1)[0], nil, 5)
	recordSpeechFrames(d, sineFrames(500, 1200, 1)[0], nil, 10)
	want := []SpeechSegment{{Started: 12 * time.Second, Ended: 12100 * time.Millisecond}}
	if got := d.Take(); !slices.Equal(got, want) {
		t.Fatalf("speech above learned noise = %v, want %v", got, want)
	}
}

func TestSpeechDetectorUsesLowerThresholdInsideSpeech(t *testing.T) {
	d := NewSpeechDetector(nil)
	recordSpeechFrames(d, nil, nil, 50) // first establish a quiet noise floor
	soft := sineFrames(500, 350, 1)[0]  // RMS ~247: below onset, above continuation
	recordSpeechFrames(d, soft, nil, 3)
	if got := d.Take(); len(got) != 0 {
		t.Fatalf("soft audio opened a segment: %v", got)
	}
	recordSpeechFrames(d, sineFrames(500, 5000, 1)[0], nil, 3)
	recordSpeechFrames(d, soft, nil, 20)
	recordSpeechFrames(d, nil, nil, 10)
	want := []SpeechSegment{{Started: 1060 * time.Millisecond, Ended: 1520 * time.Millisecond}}
	if got := d.Take(); !slices.Equal(got, want) {
		t.Fatalf("soft speech was cut off: %v", got)
	}
}

type alwaysVoice struct{}

func (alwaysVoice) IsSpeech([]byte, bool) bool { return true }

func TestSpeechDetectorAcceptsReplacementClassifier(t *testing.T) {
	d := NewSpeechDetector(alwaysVoice{})
	recordSpeechFrames(d, nil, nil, 5)
	want := []SpeechSegment{{Started: 0, Ended: 100 * time.Millisecond}}
	if got := d.Take(); !slices.Equal(got, want) {
		t.Fatalf("replacement classifier was not used: %v", got)
	}
}

func TestFramePowerMatchesRecordedPaddingAndTruncation(t *testing.T) {
	for _, pcm := range [][]byte{nil, {}, {255}} {
		if got := framePower(pcm); got != 0 {
			t.Fatalf("incomplete samples have power %v", got)
		}
	}
	samples := make([]int16, FrameSamples)
	for i := range samples {
		samples[i] = -32768
	}
	pcm := int16ToPCM(samples)
	if got, want := framePower(pcm), 32768.0*32768.0; got != want {
		t.Fatalf("full-scale power = %v, want %v", got, want)
	}
	if got, want := framePower(pcm[:FrameBytes/2]), framePower(pcm)/2; got != want {
		t.Fatalf("short frame power = %v, want silence-padded %v", got, want)
	}
	if got := framePower(append(make([]byte, FrameBytes), pcm...)); got != 0 {
		t.Fatalf("unrecorded tail contributed power %v", got)
	}
}
