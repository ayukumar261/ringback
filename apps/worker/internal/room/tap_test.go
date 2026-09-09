package room

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
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
	return newTap(w, log), path
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
	rec.offer(toneFrame(lowHz))
	rec.press('1')
	rec.record(make([]byte, audio.FrameBytes))
	if err := rec.close(); err != nil {
		t.Fatalf("nil tap close returned %v", err)
	}
}

func TestTapStopsAfterWriteError(t *testing.T) {
	var logged bytes.Buffer
	rec, path := newTestTap(t, slog.New(slog.NewTextHandler(&logged, nil)))
	frame := make([]byte, audio.FrameBytes)
	rec.record(frame)
	if err := rec.close(); err != nil {
		t.Fatal(err)
	}
	rec.record(frame) // the file is closed so this write fails
	rec.record(frame) // and this one is skipped

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
