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

func TestTapKeepsLatestOffer(t *testing.T) {
	rec, path := newTestTap(t, discard)
	rec.offer(toneFrame(lowHz))
	rec.offer(toneFrame(highHz))
	silence := make([]byte, audio.FrameBytes)
	rec.record(silence)
	rec.record(silence)
	if err := rec.close(); err != nil {
		t.Fatal(err)
	}

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data := b[44:]
	if len(data) != 2*2*audio.FrameBytes {
		t.Fatalf("recorded %d bytes, want two stereo frames", len(data))
	}
	left, _ := deinterleave(data[:2*audio.FrameBytes])
	if c := crossings(left); c < 45 {
		t.Errorf("first tick has %d crossings on the left, want the newest high tone", c)
	}
	left, _ = deinterleave(data[2*audio.FrameBytes:])
	if e := rms(left); e != 0 {
		t.Errorf("second tick has rms %.0f on the left, want the drained slot's silence", e)
	}
}

func TestTapNilIsInert(t *testing.T) {
	var rec *tap
	rec.offer(toneFrame(lowHz))
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
