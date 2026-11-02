package room

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

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
	go func() { done <- pace(ctx, tick, buf, enc, nil, write) }()
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

	err = pace(context.Background(), tick, audio.NewPlayoutBuffer(), enc, nil, func([]byte) error { return boom })
	if !errors.Is(err, boom) {
		t.Fatalf("pace returned %v, want boom", err)
	}
}

func TestPaceRecordsBothSides(t *testing.T) {
	enc, err := audio.NewEncoder()
	if err != nil {
		t.Fatal(err)
	}
	rec, path := newTestTap(t, discard)
	rec.offer(toneFrame(highHz)) // the caller spoke once before the first tick
	buf := audio.NewPlayoutBuffer()
	buf.Push(toneFrame(lowHz)) // the agent has one frame queued

	tick := make(chan time.Time)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- pace(ctx, tick, buf, enc, rec, func([]byte) error { return nil }) }()
	for range 3 {
		tick <- time.Time{}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("pace returned %v", err)
	}
	if err := rec.close(); err != nil {
		t.Fatal(err)
	}

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data := b[44:]
	if len(data) != 3*2*audio.FrameBytes {
		t.Fatalf("recorded %d bytes, want three stereo frames", len(data))
	}
	left, right := deinterleave(data[:2*audio.FrameBytes])
	if c := crossings(left); c < 45 {
		t.Errorf("frame 0 left has %d crossings, want the caller's high tone", c)
	}
	if c, e := crossings(right), rms(right); c > 35 || e < 1000 {
		t.Errorf("frame 0 right has %d crossings and rms %.0f, want the agent's low tone", c, e)
	}
	left, right = deinterleave(data[2*2*audio.FrameBytes:])
	if l, r := rms(left), rms(right); l != 0 || r != 0 {
		t.Errorf("frame 2 has rms %.0f left and %.0f right, want silence on both sides", l, r)
	}
}

func TestPaceRecordsOnlyAnsweredCall(t *testing.T) {
	for _, answered := range []bool{false, true} {
		name := "unanswered"
		if answered {
			name = "answered"
		}
		t.Run(name, func(t *testing.T) {
			enc, err := audio.NewEncoder()
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "call.wav")
			rec := newTap(path, discard)
			t.Cleanup(func() { rec.close() })
			r := &Room{tap: rec, audio: "call.wav", answered: make(chan struct{}), log: discard}
			r.onAttributesChanged(map[string]string{livekit.AttrSIPCallStatus: "ringing"}, nil)
			rec.offer(toneFrame(lowHz))
			rec.press('5')
			buf := audio.NewPlayoutBuffer()
			for range 3 {
				buf.Push(toneFrame(lowHz))
			}
			for range 3 {
				buf.Push(toneFrame(highHz))
			}
			tick := make(chan time.Time, 6)
			for range 6 {
				tick <- time.Time{}
			}
			finished := errors.New("finished")
			packets := 0
			var answeredAt time.Time
			err = pace(t.Context(), tick, buf, enc, rec, func([]byte) error {
				packets++
				if packets == 3 {
					if _, err := os.Stat(path); !os.IsNotExist(err) {
						t.Fatalf("ringing created a recording: %v", err)
					}
					if r.AudioFile() != "" || !r.StartedAt().IsZero() || r.Recorded() != 0 || r.Speech() != nil {
						t.Fatal("ringing reported recorded audio")
					}
					if answered {
						answeredAt = time.Now()
						r.onAttributesChanged(map[string]string{livekit.AttrSIPCallStatus: sipStatusActive}, nil)
						rec.offer(toneFrame(highHz))
					}
				}
				if packets == 4 && answered {
					// A repeated active event must not truncate or restart the recording.
					r.onAttributesChanged(map[string]string{livekit.AttrSIPCallStatus: sipStatusActive}, nil)
				}
				if packets == 6 {
					return finished
				}
				return nil
			})
			if !errors.Is(err, finished) || packets != 6 {
				t.Fatalf("playout stopped: %d packets, %v", packets, err)
			}
			if err := rec.close(); err != nil {
				t.Fatal(err)
			}
			if !answered {
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatalf("unanswered call created a recording: %v", err)
				}
				if r.AudioFile() != "" {
					t.Fatalf("unanswered audio file = %q", r.AudioFile())
				}
				return
			}
			if r.AudioFile() != "call.wav" || r.StartedAt().Before(answeredAt) || r.Recorded() != 3*audio.FrameDuration {
				t.Fatalf("incorrect answered recording: file=%q start=%v duration=%v", r.AudioFile(), r.StartedAt(), r.Recorded())
			}
			b, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if len(b) != 44+3*2*audio.FrameBytes {
				t.Fatalf("recorded %d bytes, want three stereo frames after answer", len(b))
			}
			left, right := deinterleave(b[44 : 44+2*audio.FrameBytes])
			if !bytes.Equal(left, toneFrame(highHz)) || !bytes.Equal(right, toneFrame(highHz)) {
				t.Fatal("recording retained audio or keypad tones from before the answer")
			}
		})
	}
}
