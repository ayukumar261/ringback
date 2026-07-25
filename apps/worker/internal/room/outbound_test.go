package room

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

func TestPaceWritesOneFramePerTick(t *testing.T) {
	enc, err := audio.NewEncoder()
	if err != nil {
		t.Fatal(err)
	}
	dec, err := audio.NewDecoder()
	if err != nil {
		t.Fatal(err)
	}
	buf := audio.NewPlayoutBuffer()
	buf.Push(toneFrame(lowHz)) // one queued frame; later ticks must pad with silence

	tick := make(chan time.Time)
	var wrote [][]byte
	write := func(packet []byte) error {
		wrote = append(wrote, packet)
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- pace(ctx, tick, buf, enc, write) }()
	for range 3 {
		tick <- time.Time{}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("pace returned %v", err)
	}

	if len(wrote) != 3 {
		t.Fatalf("wrote %d packets, want 3", len(wrote))
	}
	var frames [][]byte
	for i, packet := range wrote {
		pcm, err := dec.Decode(packet)
		if err != nil {
			t.Fatalf("packet %d does not decode: %v", i, err)
		}
		if len(pcm) != audio.FrameBytes {
			t.Fatalf("packet %d decodes to %d bytes, want %d", i, len(pcm), audio.FrameBytes)
		}
		frames = append(frames, pcm)
	}
	// Frame 1 carries the tone's Opus overlap-add tail, so only 0 and 2 are asserted.
	if e := rms(frames[0]); e < 1000 {
		t.Errorf("frame 0 rms %.0f, want the queued tone", e)
	}
	if e := rms(frames[2]); e > 500 {
		t.Errorf("frame 2 rms %.0f, want padded silence", e)
	}
}

func TestPaceStopsOnWriteError(t *testing.T) {
	enc, err := audio.NewEncoder()
	if err != nil {
		t.Fatal(err)
	}
	boom := errors.New("boom")
	tick := make(chan time.Time, 1)
	tick <- time.Time{}

	err = pace(context.Background(), tick, audio.NewPlayoutBuffer(), enc, func([]byte) error { return boom })
	if !errors.Is(err, boom) {
		t.Fatalf("pace returned %v, want boom", err)
	}
}
