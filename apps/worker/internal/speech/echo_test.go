package speech

import (
	"bytes"
	"encoding/binary"
	"math"
	"slices"
	"testing"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

func TestEchoAdapterDelay(t *testing.T) {
	f, err := newEchoFilter()
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []float32
	for n := range 15 {
		pcm := make([]byte, audio.FrameBytes)
		if n == 5 {
			binary.LittleEndian.PutUint16(pcm[300*2:], 20000)
		}
		result, err := f.Process(pcm, nil)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, result...)
	}
	peak := 0
	for i, v := range out {
		if math.Abs(float64(v)) > math.Abs(float64(out[peak])) {
			peak = i
		}
	}
	if got := int64(peak - (5*detectionFrame + 100)); got != f.delay {
		t.Fatalf("impulse delay %d samples, mapping compensates %d", got, f.delay)
	}
}

func TestEchoAdapterPaddingTruncationAndCopies(t *testing.T) {
	a, err := newEchoFilter()
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := newEchoFilter()
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	for n := range 12 {
		pcm := make([]byte, audio.FrameBytes)
		binary.LittleEndian.PutUint16(pcm, 12000)
		var input []byte
		if n%2 == 0 {
			input = append(append([]byte(nil), pcm...), 255, 127)
		} else {
			input = append([]byte(nil), pcm[:3]...)
		}
		original := append([]byte(nil), input...)
		x, err := a.Process(input, nil)
		if err != nil {
			t.Fatal(err)
		}
		y, err := b.Process(pcm, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(x, y) {
			t.Fatal("adapter did not use WAV padding/truncation")
		}
		if !bytes.Equal(input, original) {
			t.Fatal("DSP changed recorded samples")
		}
	}
}
