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
