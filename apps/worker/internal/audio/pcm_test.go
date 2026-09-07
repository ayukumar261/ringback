package audio

import (
	"bytes"
	"math"
	"reflect"
	"testing"
)

func TestPCMConversionGolden(t *testing.T) {
	for _, tt := range []struct {
		name   string
		b      []byte
		s      []int16
		oneWay bool
	}{
		{"zero", []byte{0x00, 0x00}, []int16{0}, false},
		{"one", []byte{0x01, 0x00}, []int16{1}, false},
		{"byte order", []byte{0x00, 0x01}, []int16{256}, false},
		{"max", []byte{0xFF, 0x7F}, []int16{32767}, false},
		{"min", []byte{0x00, 0x80}, []int16{-32768}, false},
		{"minus one", []byte{0xFF, 0xFF}, []int16{-1}, false},
		{"sequence", []byte{0x01, 0x00, 0xFF, 0xFF, 0x00, 0x80}, []int16{1, -1, -32768}, false},
		{"odd tail dropped", []byte{0x01, 0x00, 0x99}, []int16{1}, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := pcmToInt16(tt.b, nil); !reflect.DeepEqual(got, tt.s) {
				t.Errorf("pcmToInt16(%v) = %v, want %v", tt.b, got, tt.s)
			}
			if tt.oneWay {
				return
			}
			if got := int16ToPCM(tt.s); !bytes.Equal(got, tt.b) {
				t.Errorf("int16ToPCM(%v) = %v, want %v", tt.s, got, tt.b)
			}
		})
	}
}

func TestPCMToInt16ReusesDst(t *testing.T) {
	dst := make([]int16, 8)
	out := pcmToInt16([]byte{0x01, 0x00, 0xFF, 0xFF}, dst)
	if len(out) != 2 || &out[0] != &dst[0] {
		t.Fatalf("pcmToInt16 did not reuse dst (len %d)", len(out))
	}
}

func TestPCMConversionExhaustive(t *testing.T) {
	for v := math.MinInt16; v <= math.MaxInt16; v++ {
		b := int16ToPCM([]int16{int16(v)})
		if got := pcmToInt16(b, nil); got[0] != int16(v) {
			t.Fatalf("round trip of %d gave %d", v, got[0])
		}
	}
}

// padded copies s into a full frame of samples, leaving the rest zero.
func padded(s []int16) []int16 {
	out := make([]int16, FrameSamples)
	copy(out, s)
	return out
}

func TestInterleave(t *testing.T) {
	full := make([]int16, FrameSamples)
	neg := make([]int16, FrameSamples)
	for i := range full {
		full[i] = int16(i + 1)
		neg[i] = -int16(i + 1)
	}
	long := append(append([]int16{}, full...), 7, 7, 7)
	for _, tt := range []struct {
		name         string
		left, right  []int16
		wantL, wantR []int16
	}{
		{"both full", full, neg, full, neg},
		{"nil right is silent", full, nil, full, padded(nil)},
		{"short left padded", full[:10], neg, padded(full[:10]), neg},
		{"long left truncated", long, neg, full, neg},
	} {
		t.Run(tt.name, func(t *testing.T) {
			out := Interleave(int16ToPCM(tt.left), int16ToPCM(tt.right))
			if len(out) != 2*FrameBytes {
				t.Fatalf("stereo frame is %d bytes, want %d", len(out), 2*FrameBytes)
			}
			s := pcmToInt16(out, nil)
			var l, r []int16
			for i := 0; i < len(s); i += 2 {
				l = append(l, s[i])
				r = append(r, s[i+1])
			}
			if !reflect.DeepEqual(l, tt.wantL) {
				t.Errorf("left channel mismatch, first samples %v", l[:12])
			}
			if !reflect.DeepEqual(r, tt.wantR) {
				t.Errorf("right channel mismatch, first samples %v", r[:12])
			}
		})
	}
}
