package speech

import (
	"errors"
	"io"
	"log/slog"
	"slices"
	"testing"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

var silentLog = slog.New(slog.NewTextHandler(io.Discard, nil))

func TestAnalyzerRetainsInferenceAcrossTranscriptCutoff(t *testing.T) {
	a := newAnalyzer(silentLog, func() *Detector { return NewDetector(&scriptedVoice{probability: .9, lag: true}) })
	defer a.Close()
	for range 5 {
		a.Record(nil, nil)
	}
	// Transcript at 100ms, while the model has processed only 80ms.
	reply := make(chan []Segment, 1)
	a.mu.Lock()
	a.enqueue(analysisCommand{cutoff: a.recorded, reply: reply})
	a.mu.Unlock()
	select {
	case <-reply:
		t.Fatal("returned before buffered input was classified")
	default:
	}
	for range 3 {
		a.Record(nil, nil)
	}
	select {
	case got := <-reply:
		if !slices.Equal(got, []Segment{{0, 100 * time.Millisecond}}) {
			t.Fatal(got)
		}
	case <-time.After(time.Second):
		t.Fatal("did not resolve transcript")
	}
	a.Close()
	if got := a.Take(); !slices.Equal(got, []Segment{{100 * time.Millisecond, 160 * time.Millisecond}}) {
		t.Fatal(got)
	}
	if len(a.Take()) != 0 {
		t.Fatal("reused late transcript")
	}
}

func TestAnalyzerHangupDrainsBeforeLateTranscript(t *testing.T) {
	a := newAnalyzer(silentLog, func() *Detector { return NewDetector(&scriptedVoice{probability: .9, lag: true}) })
	for range 5 {
		a.Record(nil, nil)
	}
	a.Close()
	a.Close()
	if got := a.Take(); !slices.Equal(got, []Segment{{0, 100 * time.Millisecond}}) {
		t.Fatal(got)
	}
}

type blockedVoice struct {
	scriptedVoice
	entered, release chan struct{}
	snapshot         []byte
}

func (v *blockedVoice) Process(caller, agent []byte) ([]VoiceFrame, error) {
	select {
	case v.entered <- struct{}{}:
	default:
	}
	<-v.release
	if v.snapshot == nil {
		v.snapshot = append([]byte(nil), caller...)
	}
	return v.scriptedVoice.Process(caller, agent)
}
func TestAnalyzerOverloadNeverBlocksRecording(t *testing.T) {
	v := &blockedVoice{entered: make(chan struct{}, 1), release: make(chan struct{})}
	a := newAnalyzer(silentLog, func() *Detector { return NewDetector(v) })
	pcm := make([]byte, audio.FrameBytes)
	pcm[0] = 7
	a.Record(pcm, nil)
	<-v.entered
	pcm[0] = 9 // queued audio must be copied, not borrowed
	start := time.Now()
	for range analysisQueue + 1 {
		a.Record(pcm, nil)
	}
	if elapsed := time.Since(start); elapsed > 50*time.Millisecond {
		t.Fatalf("enqueue blocked for %v", elapsed)
	}
	if len(a.Take()) != 0 {
		t.Fatal("overload invented timestamps")
	}
	close(v.release)
	select {
	case <-a.done:
	case <-time.After(time.Second):
		t.Fatal("leaked analyzer")
	}
	if v.snapshot[0] != 7 {
		t.Fatal("queued audio changed with producer buffer")
	}
	if !v.closed {
		t.Fatal("native resource not closed")
	}
}
func TestAnalyzerInitializationAndInferenceFailure(t *testing.T) {
	for _, init := range []bool{true, false} {
		t.Run(map[bool]string{true: "initialization", false: "inference"}[init], func(t *testing.T) {
			a := newAnalyzer(silentLog, func() *Detector {
				if init {
					return &Detector{err: errors.New("missing runtime")}
				}
				return NewDetector(&scriptedVoice{failure: errors.New("native failure")})
			})
			a.Record(nil, nil)
			a.Close()
			if len(a.Take()) != 0 {
				t.Fatal("failure invented timestamps")
			}
			select {
			case <-a.failed:
			case <-time.After(time.Second):
				t.Fatal("failure was not reported")
			}
		})
	}
}
func TestAnalyzerTimeoutDisablesInsteadOfDroppingBufferedTail(t *testing.T) {
	a := newAnalyzer(silentLog, func() *Detector { return NewDetector(&scriptedVoice{probability: .9, lag: true}) })
	a.Record(nil, nil)
	start := time.Now()
	got := a.Take()
	if len(got) != 0 || time.Since(start) > time.Second {
		t.Fatal("timeout did not fail closed promptly")
	}
	a.Close()
	select {
	case <-a.failed:
	default:
		t.Fatal("timeout did not disable timestamps")
	}
}
