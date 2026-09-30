package speech

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

// The clock tests use explicit probabilities; tones are not speech fixtures.
type scriptedVoice struct {
	position    time.Duration
	probability float64
	failure     error
	buffered    []VoiceFrame
	lag         bool
	closed      bool
}

func (v *scriptedVoice) Process(caller, agent []byte) ([]VoiceFrame, error) {
	f := VoiceFrame{v.position, v.position + audio.FrameDuration, v.probability}
	v.position += audio.FrameDuration
	v.buffered = append(v.buffered, f)
	if v.lag && len(v.buffered) < 4 {
		return nil, v.failure
	}
	result := v.buffered
	v.buffered = nil
	return result, v.failure
}
func (v *scriptedVoice) Flush() ([]VoiceFrame, error) {
	result := v.buffered
	v.buffered = nil
	return result, v.failure
}
func (v *scriptedVoice) Close() { v.closed = true }
func recordSpeechFrames(d *Detector, caller, agent []byte, n int) {
	for range n {
		d.Record(caller, agent)
	}
}
func feed(d *Detector, v *scriptedVoice, p float64, n int) {
	v.probability = p
	recordSpeechFrames(d, nil, nil, n)
}

func TestSpeechClockAndPauses(t *testing.T) {
	v := &scriptedVoice{}
	d := NewDetector(v)
	feed(d, v, 0, 10)
	feed(d, v, .9, 15)
	feed(d, v, 0, 20)
	feed(d, v, .9, 8)
	feed(d, v, 0, 12)
	want := []Segment{{168 * time.Millisecond, 500 * time.Millisecond}, {868 * time.Millisecond, 1060 * time.Millisecond}}
	if got := d.Take(); !slices.Equal(got, want) {
		t.Fatalf("%v != %v", got, want)
	}
	if len(d.Take()) != 0 {
		t.Fatal("reused segments")
	}
}
func TestSpeechRejectsClicksAndJoinsPauses(t *testing.T) {
	v := &scriptedVoice{}
	d := NewDetector(v)
	feed(d, v, .9, 2)
	feed(d, v, 0, 10)
	if len(d.Take()) != 0 {
		t.Fatal("40ms click classified")
	}
	feed(d, v, .9, 5)
	feed(d, v, 0, 5)
	feed(d, v, .4, 5)
	feed(d, v, 0, 10)
	want := []Segment{{240 * time.Millisecond, 540 * time.Millisecond}}
	if got := d.Take(); !slices.Equal(got, want) {
		t.Fatalf("%v != %v", got, want)
	}
}
func TestSpeechSplitsAtTranscriptWithoutLosingFutureInference(t *testing.T) {
	v := &scriptedVoice{probability: .9}
	d := NewDetector(v)
	recordSpeechFrames(d, nil, nil, 8)
	if got := d.takeAt(100 * time.Millisecond); !slices.Equal(got, []Segment{{0, 100 * time.Millisecond}}) {
		t.Fatal(got)
	}
	if got := d.Take(); !slices.Equal(got, []Segment{{100 * time.Millisecond, 160 * time.Millisecond}}) {
		t.Fatal(got)
	}
	recordSpeechFrames(d, nil, nil, 5)
	if got := d.Take(); !slices.Equal(got, []Segment{{160 * time.Millisecond, 260 * time.Millisecond}}) {
		t.Fatal(got)
	}
}
func TestSpeechFinishDrainsPendingAndKeepsLateTranscript(t *testing.T) {
	v := &scriptedVoice{probability: .9, lag: true}
	d := NewDetector(v)
	recordSpeechFrames(d, nil, nil, 5)
	d.Finish()
	d.Finish()
	if !v.closed || d.Err() != nil {
		t.Fatalf("closed=%v err=%v", v.closed, d.Err())
	}
	if got := d.Take(); !slices.Equal(got, []Segment{{0, 100 * time.Millisecond}}) {
		t.Fatal(got)
	}
}
func TestSpeechDoesNotReuseUnconfirmedOnset(t *testing.T) {
	v := &scriptedVoice{probability: .9}
	d := NewDetector(v)
	recordSpeechFrames(d, nil, nil, 2)
	if len(d.Take()) != 0 {
		t.Fatal("unconfirmed onset")
	}
	recordSpeechFrames(d, nil, nil, 4)
	if got := d.Take(); !slices.Equal(got, []Segment{{40 * time.Millisecond, 120 * time.Millisecond}}) {
		t.Fatal(got)
	}
}
func TestSpeechFailureOmitsUnclaimedSpans(t *testing.T) {
	v := &scriptedVoice{probability: .9}
	d := NewDetector(v)
	recordSpeechFrames(d, nil, nil, 10)
	v.failure = errors.New("inference failed")
	d.Record(nil, nil)
	d.Finish()
	if d.Err() == nil || len(d.Take()) != 0 || !v.closed {
		t.Fatal("failed detector exposed timestamps or leaked state")
	}
}
func TestSpeechRejectsDiscontinuousClock(t *testing.T) {
	v := &scriptedVoice{position: audio.FrameDuration, probability: .9}
	d := NewDetector(v)
	d.Record(nil, nil)
	if d.Err() == nil {
		t.Fatal("accepted a skipped interval")
	}
}
