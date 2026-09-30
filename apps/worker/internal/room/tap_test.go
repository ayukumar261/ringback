package room

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
	"github.com/ayukumar261/ringback/apps/worker/internal/speech"
	"github.com/ayukumar261/ringback/apps/worker/internal/wav"
)

// newTestTap opens a stereo writer in a temp dir and returns the tap and its path.
func newTestTap(t *testing.T, log *slog.Logger) (*tap, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "call.wav")
	w, err := wav.NewWriter(path, audio.SampleRate, 2)
	if err != nil {
		t.Fatal(err)
	}
	rec := &tap{w: w, log: log, speech: &fakeSpeechAnalyzer{d: speech.NewDetector(&fakeVoice{})}}
	t.Cleanup(func() { rec.close() })
	return rec, path
}

// deinterleave splits one stereo frame into its left and right mono frames.
func deinterleave(stereo []byte) (left, right []byte) {
	for i := 0; i+4 <= len(stereo); i += 4 {
		left = append(left, stereo[i], stereo[i+1])
		right = append(right, stereo[i+2], stereo[i+3])
	}
	return left, right
}

// leftFrames records n ticks of agent silence, closes the tap, and returns each tick's left channel.
func leftFrames(t *testing.T, rec *tap, path string, n int) [][]byte {
	t.Helper()
	silence := make([]byte, audio.FrameBytes)
	for range n {
		rec.record(silence)
	}
	if err := rec.close(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data := b[44:]
	if len(data) != n*2*audio.FrameBytes {
		t.Fatalf("recorded %d bytes, want %d stereo frames", len(data), n)
	}
	var lefts [][]byte
	for i := range n {
		left, _ := deinterleave(data[i*2*audio.FrameBytes : (i+1)*2*audio.FrameBytes])
		lefts = append(lefts, left)
	}
	return lefts
}

func TestTapQueuesOffersInOrder(t *testing.T) {
	rec, path := newTestTap(t, discard)
	rec.offer(toneFrame(lowHz))
	rec.offer(toneFrame(highHz))
	lefts := leftFrames(t, rec, path, 3)

	if c := crossings(lefts[0]); c < 10 || c > 30 {
		t.Errorf("first tick has %d crossings on the left, want the older low tone", c)
	}
	if c := crossings(lefts[1]); c < 45 {
		t.Errorf("second tick has %d crossings on the left, want the newer high tone", c)
	}
	if e := rms(lefts[2]); e != 0 {
		t.Errorf("third tick has rms %.0f on the left, want silence from the empty queue", e)
	}
}

func TestTapDropsOldestPastCap(t *testing.T) {
	rec, path := newTestTap(t, discard)
	rec.offer(toneFrame(lowHz))
	for range callerQueueCap {
		rec.offer(toneFrame(highHz))
	}
	lefts := leftFrames(t, rec, path, callerQueueCap+1)

	for i := range callerQueueCap {
		if c := crossings(lefts[i]); c < 45 {
			t.Errorf("tick %d has %d crossings on the left, want the high tone that outlived the dropped low one", i, c)
		}
	}
	if e := rms(lefts[callerQueueCap]); e != 0 {
		t.Errorf("tick %d has rms %.0f on the left, want silence from the empty queue", callerQueueCap, e)
	}
}

func TestTapMixesPressIntoAgentChannel(t *testing.T) {
	rec, path := newTestTap(t, discard)
	rec.press('5')
	agent := make([]byte, audio.FrameBytes)
	toneFrames := 2 * audio.DTMFSamples / audio.FrameBytes
	for range toneFrames + 1 {
		rec.record(agent)
	}
	if err := rec.close(); err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(agent, make([]byte, audio.FrameBytes)) {
		t.Fatal("record changed the live agent frame, want only the recording to carry the beep")
	}
	if rec.tone != nil {
		t.Errorf("tap still holds %d tone bytes after the beep played out, want none", len(rec.tone))
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data := b[44:]
	if len(data) != (toneFrames+1)*2*audio.FrameBytes {
		t.Fatalf("recorded %d bytes, want %d stereo frames", len(data), toneFrames+1)
	}
	for i := range toneFrames + 1 {
		left, right := deinterleave(data[i*2*audio.FrameBytes : (i+1)*2*audio.FrameBytes])
		if e := rms(left); e != 0 {
			t.Errorf("tick %d has rms %.0f on the caller channel, want silence", i, e)
		}
		e := rms(right)
		if i < toneFrames && e < 3000 {
			t.Errorf("tick %d has rms %.0f on the agent channel, want the beep", i, e)
		}
		if i == toneFrames && e != 0 {
			t.Errorf("tick %d has rms %.0f on the agent channel, want silence after the beep", i, e)
		}
	}
}

func TestTapPressClampsLoudAgent(t *testing.T) {
	rec, path := newTestTap(t, discard)
	rec.press('1')
	loud := make([]byte, audio.FrameBytes)
	for i := 0; i < audio.FrameBytes; i += 2 {
		loud[i], loud[i+1] = 0xFF, 0x7F
	}
	rec.record(loud)
	if err := rec.close(); err != nil {
		t.Fatal(err)
	}

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	_, right := deinterleave(b[44:])
	for i := 0; i < len(right); i += 2 {
		if v := int16(uint16(right[i]) | uint16(right[i+1])<<8); v < 0 {
			t.Fatalf("sample %d wrapped to %d, want the sum clamped at the int16 ceiling", i/2, v)
		}
	}
}

func TestTapNilIsInert(t *testing.T) {
	var rec *tap
	if got := rec.Speech(); got != nil {
		t.Fatalf("nil tap speech = %v, want nil", got)
	}
	if got := rec.StartedAt(); !got.IsZero() {
		t.Fatalf("nil tap started at %v, want zero", got)
	}
	if got := rec.Recorded(); got != 0 {
		t.Fatalf("nil tap recorded %v, want zero", got)
	}
	rec.offer(toneFrame(lowHz))
	rec.press('1')
	rec.record(make([]byte, audio.FrameBytes))
	if err := rec.close(); err != nil {
		t.Fatalf("nil tap close returned %v", err)
	}
}

func TestTapReportsRecordingClock(t *testing.T) {
	rec, _ := newTestTap(t, discard)
	if got := rec.StartedAt(); !got.IsZero() {
		t.Fatalf("new tap started at %v, want zero", got)
	}
	if got := rec.Recorded(); got != 0 {
		t.Fatalf("new tap recorded %v, want zero", got)
	}

	frame := make([]byte, audio.FrameBytes)
	before := time.Now()
	rec.record(frame)
	after := time.Now()
	started := rec.StartedAt()
	if started.Before(before) || started.After(after) {
		t.Fatalf("started at %v, want first write instant between %v and %v", started, before, after)
	}
	for range 4 {
		rec.record(frame)
	}
	if got, want := rec.StartedAt(), started; !got.Equal(want) {
		t.Fatalf("started at changed to %v, want %v", got, want)
	}
	if got, want := rec.Recorded(), 5*audio.FrameDuration; got != want {
		t.Fatalf("recorded %v, want %v", got, want)
	}
}

func TestRoomPassesThroughRecordingClock(t *testing.T) {
	var off Room
	if got := off.Speech(); got != nil {
		t.Fatalf("room without recording speech = %v, want nil", got)
	}
	if got := off.StartedAt(); !got.IsZero() {
		t.Fatalf("room without recording started at %v, want zero", got)
	}
	if got := off.Recorded(); got != 0 {
		t.Fatalf("room without recording recorded %v, want zero", got)
	}

	rec, _ := newTestTap(t, discard)
	rm := Room{tap: rec}
	rec.record(make([]byte, audio.FrameBytes))
	if got, want := rm.StartedAt(), rec.StartedAt(); !got.Equal(want) {
		t.Fatalf("room started at %v, want tap start %v", got, want)
	}
	if got, want := rm.Recorded(), audio.FrameDuration; got != want {
		t.Fatalf("room recorded %v, want %v", got, want)
	}
}

func TestTapSpeechMatchesStereoWAV(t *testing.T) {
	tone := toneFrame(lowHz)
	loud := audio.Mix(tone, audio.Mix(tone, tone))
	bursts := []speech.Segment{
		{Started: 168 * time.Millisecond, Ended: 500 * time.Millisecond},
		{Started: 768 * time.Millisecond, Ended: 900 * time.Millisecond},
	}
	for _, tt := range []struct {
		name          string
		caller, agent []byte
		want          []speech.Segment
	}{
		{name: "caller bursts", caller: tone, want: bursts},
		{name: "silence", agent: tone},
		{name: "equal-level echo", caller: tone, agent: tone},
		{name: "louder caller over agent", caller: loud, agent: tone, want: bursts},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec, path := newTestTap(t, discard)
			rm := Room{tap: rec}
			for i := range 60 {
				if (i >= 10 && i < 25) || (i >= 40 && i < 45) {
					rec.offer(tt.caller)
				}
				rec.record(tt.agent)
			}
			if err := rec.close(); err != nil {
				t.Fatal(err)
			}
			b, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if len(b) != 44+60*2*audio.FrameBytes || binary.LittleEndian.Uint16(b[22:24]) != 2 {
				t.Fatal("expected 60 frames in a stereo WAV")
			}
			// Replay the saved channels through the pure detector, independently of
			// offers and the tap's wall clock, to check against what reached the WAV.
			detector := speech.NewDetector(&fakeVoice{})
			for offset := 44; offset < len(b); offset += 2 * audio.FrameBytes {
				left, right := deinterleave(b[offset : offset+2*audio.FrameBytes])
				detector.Record(left, right)
			}
			if got := detector.Take(); !slices.Equal(got, tt.want) {
				t.Fatalf("WAV speech = %v, want %v", got, tt.want)
			}
			if got := rm.Speech(); !slices.Equal(got, tt.want) {
				t.Fatalf("room speech = %v, want WAV edges %v", got, tt.want)
			}
			if got := rm.Speech(); len(got) != 0 {
				t.Fatalf("room returned consumed speech again: %v", got)
			}
		})
	}
}

func TestTapSpeechUsesQueuedFramesWhenTheyAreWritten(t *testing.T) {
	rec, path := newTestTap(t, discard)
	for range 5 {
		rec.record(nil)
	}
	for range 4 {
		rec.offer(toneFrame(lowHz))
	}
	for range 4 {
		rec.record(nil)
	}
	want := []speech.Segment{{Started: 68 * time.Millisecond, Ended: 180 * time.Millisecond}}
	if got := rec.Speech(); !slices.Equal(got, want) {
		t.Fatalf("queued speech = %v, want written positions %v", got, want)
	}
	if err := rec.close(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	left, _ := deinterleave(b[44:])
	if !bytes.Equal(left[:5*audio.FrameBytes], make([]byte, 5*audio.FrameBytes)) {
		t.Fatal("WAV unexpectedly contains caller speech before the queued frames were written")
	}
}

func TestTapSpeechIgnoresFailedWritesAndSurvivesClose(t *testing.T) {
	rec, _ := newTestTap(t, discard)
	for range 4 {
		rec.offer(toneFrame(lowHz))
		rec.record(nil)
	}
	if err := rec.close(); err != nil {
		t.Fatal(err)
	}
	for range 5 {
		rec.offer(toneFrame(lowHz))
		rec.record(nil)
	}
	want := []speech.Segment{{Started: 0, Ended: 80 * time.Millisecond}}
	if got := rec.Speech(); !slices.Equal(got, want) {
		t.Fatalf("speech after write failure = %v, want saved frames %v", got, want)
	}
}

func TestTapSpeechAndRecordingConcurrent(t *testing.T) {
	rec, _ := newTestTap(t, discard)
	defer rec.close()
	tone := toneFrame(lowHz)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for range 100 {
			rec.offer(tone)
			rec.record(nil)
		}
	}()
	var previous time.Duration
	for {
		for _, segment := range rec.Speech() {
			if segment.Started < previous || segment.Ended < segment.Started || segment.Ended > rec.Recorded() {
				t.Fatalf("invalid or overlapping speech segment: %+v after %v", segment, previous)
			}
			previous = segment.Ended
		}
		select {
		case <-done:
			return
		default:
		}
	}
}

func TestTapStopsAfterWriteError(t *testing.T) {
	var logged bytes.Buffer
	rec, path := newTestTap(t, slog.New(slog.NewTextHandler(&logged, nil)))
	frame := make([]byte, audio.FrameBytes)
	rec.record(frame)
	if err := rec.w.Close(); err != nil {
		t.Fatal(err)
	}
	rec.record(frame) // the file is closed so this write fails
	stoppedAt := rec.Recorded()
	rec.record(frame) // and this one is skipped
	if got := rec.Recorded(); got != stoppedAt {
		t.Errorf("recorded advanced after stop from %v to %v", stoppedAt, got)
	}

	if n := strings.Count(logged.String(), "stopping call audio recording"); n != 1 {
		t.Errorf("logged the stop %d times, want once", n)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) != 44+2*audio.FrameBytes {
		t.Errorf("file is %d bytes, want the one frame written before the error", len(b))
	}
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

type fakeSpeechAnalyzer struct {
	mu sync.Mutex
	d  *speech.Detector
}

func (a *fakeSpeechAnalyzer) Record(caller, agent []byte) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.d.Record(caller, agent)
}
func (a *fakeSpeechAnalyzer) Take() []speech.Segment {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.d.Take()
}
func (a *fakeSpeechAnalyzer) Close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.d.Finish()
}

func (a *fakeSpeechAnalyzer) Stop() { a.Close() }

// Run explicitly with -run '^$' -bench BenchmarkTapConcurrentSpeech -benchtime=1x.
// This exercises real-time pacing, native inference, and WAV writes together.
func BenchmarkTapConcurrentSpeech(b *testing.B) {
	source, rate, err := wav.Read("../speech/testdata/caller.wav")
	if err != nil || rate != 16000 {
		b.Fatal(err, rate)
	}
	pcm := make([]byte, len(source)*3)
	for i := 0; i < len(source); i += 2 {
		for j := range 3 {
			copy(pcm[3*i+2*j:], source[i:i+2])
		}
	}
	for _, calls := range []int{1, 8, 32} {
		b.Run(fmt.Sprint(calls), func(b *testing.B) {
			for range b.N {
				var taps []*tap
				var paths []string
				dir := b.TempDir()
				for n := range calls {
					path := fmt.Sprintf("%s/%d.wav", dir, n)
					w, err := wav.NewWriter(path, audio.SampleRate, 2)
					if err != nil {
						b.Fatal(err)
					}
					taps = append(taps, newTap(w, discard))
					paths = append(paths, path)
				}
				var before, after syscall.Rusage
				syscall.Getrusage(syscall.RUSAGE_SELF, &before)
				start := time.Now()
				tick := time.NewTicker(audio.FrameDuration)
				var latencies []time.Duration
				var lastTick time.Time
				skippedTicks := 0
				for i := 0; i < len(pcm); i += audio.FrameBytes {
					tickAt := <-tick.C
					if !lastTick.IsZero() {
						skippedTicks += max(0, int((tickAt.Sub(lastTick)+audio.FrameDuration/2)/audio.FrameDuration)-1)
					}
					lastTick = tickAt
					t0 := time.Now()
					for _, tap := range taps {
						tap.offer(pcm[i : i+audio.FrameBytes])
						tap.record(nil)
					}
					latencies = append(latencies, time.Since(t0))
				}
				tick.Stop()
				for n, tap := range taps {
					tap.close()
					if len(tap.Speech()) == 0 {
						b.Fatal("analysis failed under load")
					}
					info, err := os.Stat(paths[n])
					if err != nil {
						b.Fatal(err)
					}
					if info.Size() != 44+int64(len(pcm)*2) || tap.Recorded() != 10*time.Second {
						b.Fatal("WAV gaps or clock drift")
					}
				}
				syscall.Getrusage(syscall.RUSAGE_SELF, &after)
				cpu := func(r syscall.Rusage) float64 {
					return float64(r.Utime.Sec+r.Stime.Sec) + float64(r.Utime.Usec+r.Stime.Usec)/1e6
				}
				elapsed := time.Since(start).Seconds()
				slices.Sort(latencies)
				rss := float64(after.Maxrss)
				if runtime.GOOS == "darwin" {
					rss /= 1024
				}
				b.ReportMetric((cpu(after)-cpu(before))/elapsed*100, "CPU-percent")
				b.ReportMetric(rss/1024, "peak-RSS-MiB")
				b.ReportMetric(float64(skippedTicks), "skipped-ticks")
				b.ReportMetric(float64(latencies[len(latencies)*99/100].Microseconds()), "write-p99-us")
				b.ReportMetric(float64(latencies[len(latencies)-1].Microseconds()), "write-max-us")
			}
		})
	}
}
