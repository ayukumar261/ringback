package audio

import (
	"bytes"
	"math"
	"strconv"
	"strings"
	"testing"
)

// sineFrames returns n phase-continuous 20 ms frames of a sine tone as PCM bytes.
func sineFrames(freq float64, amp int16, n int) [][]byte {
	frames := make([][]byte, n)
	k := 0
	for i := range frames {
		s := make([]int16, FrameSamples)
		for j := range s {
			s[j] = int16(float64(amp) * math.Sin(2*math.Pi*freq*float64(k)/SampleRate))
			k++
		}
		frames[i] = int16ToPCM(s)
	}
	return frames
}

// rms returns the root-mean-square amplitude of a PCM byte stream.
func rms(pcm []byte) float64 {
	s := pcmToInt16(pcm, nil)
	if len(s) == 0 {
		return 0
	}
	var sum float64
	for _, v := range s {
		sum += float64(v) * float64(v)
	}
	return math.Sqrt(sum / float64(len(s)))
}

// zeroCrossings counts sign changes in a PCM byte stream.
func zeroCrossings(pcm []byte) int {
	s := pcmToInt16(pcm, nil)
	count := 0
	for i := 1; i < len(s); i++ {
		if (s[i-1] < 0) != (s[i] < 0) {
			count++
		}
	}
	return count
}

func TestNewEncoderDecoder(t *testing.T) {
	enc, err := NewEncoder()
	if err != nil || enc == nil {
		t.Fatalf("NewEncoder() = %v, %v", enc, err)
	}
	dec, err := NewDecoder()
	if err != nil || dec == nil {
		t.Fatalf("NewDecoder() = %v, %v", dec, err)
	}
}

func TestEncodeFrameSizeValidation(t *testing.T) {
	enc, err := NewEncoder()
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name string
		pcm  []byte
	}{
		{"nil", nil},
		{"empty", []byte{}},
		{"one short", make([]byte, FrameBytes-1)},
		{"one long", make([]byte, FrameBytes+1)},
		{"two frames", make([]byte, 2*FrameBytes)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			packet, err := enc.Encode(tt.pcm)
			if err == nil || packet != nil {
				t.Fatalf("Encode(%d bytes) = %v, %v; want nil, error", len(tt.pcm), packet, err)
			}
			if !strings.Contains(err.Error(), "1920") {
				t.Fatalf("error %q does not name the required frame size", err)
			}
		})
	}
	packet, err := enc.Encode(make([]byte, FrameBytes))
	if err != nil {
		t.Fatalf("Encode(silence frame): %v", err)
	}
	if len(packet) < 1 || len(packet) > maxPacketBytes {
		t.Fatalf("packet length %d outside [1, %d]", len(packet), maxPacketBytes)
	}
}

func TestEncodeReturnsIndependentPackets(t *testing.T) {
	enc, err := NewEncoder()
	if err != nil {
		t.Fatal(err)
	}
	p1, err := enc.Encode(make([]byte, FrameBytes))
	if err != nil {
		t.Fatal(err)
	}
	c1 := bytes.Clone(p1)
	p2, err := enc.Encode(sineFrames(440, 9830, 1)[0])
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(p1, c1) {
		t.Fatal("second Encode mutated the first returned packet")
	}
	if bytes.Equal(p1, p2) {
		t.Fatal("different frames produced identical packets")
	}
}

func TestDecodeInvalidPacket(t *testing.T) {
	dec, err := NewDecoder()
	if err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name   string
		packet []byte
	}{
		{"nil", nil},
		{"empty", []byte{}},
		{"code3 missing count", []byte{0xFF}},
		{"code3 zero frames", []byte{0xFF, 0x00}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			pcm, err := dec.Decode(tt.packet)
			if err == nil || pcm != nil {
				t.Fatalf("Decode(%v) = %d bytes, %v; want nil, error", tt.packet, len(pcm), err)
			}
		})
	}
}

func TestRoundTripTone(t *testing.T) {
	for _, freq := range []float64{200, 440, 1000} {
		t.Run(strconv.Itoa(int(freq))+"Hz", func(t *testing.T) {
			enc, err := NewEncoder()
			if err != nil {
				t.Fatal(err)
			}
			dec, err := NewDecoder()
			if err != nil {
				t.Fatal(err)
			}
			frames := sineFrames(freq, 9830, 50)
			decoded := make([][]byte, 0, len(frames))
			for i, f := range frames {
				packet, err := enc.Encode(f)
				if err != nil {
					t.Fatalf("frame %d: encode: %v", i, err)
				}
				pcm, err := dec.Decode(packet)
				if err != nil {
					t.Fatalf("frame %d: decode: %v", i, err)
				}
				if len(pcm) != FrameBytes {
					t.Fatalf("frame %d: decoded %d bytes, want %d", i, len(pcm), FrameBytes)
				}
				decoded = append(decoded, pcm)
			}
			in := bytes.Join(frames[2:], nil)
			out := bytes.Join(decoded[2:], nil)
			ratio := rms(out) / rms(in)
			if ratio < 0.7 || ratio > 1.4 {
				t.Errorf("RMS ratio %.3f outside [0.7, 1.4]", ratio)
			}
			zIn, zOut := zeroCrossings(in), zeroCrossings(out)
			if diff := zOut - zIn; diff < -zIn/10 || diff > zIn/10 {
				t.Errorf("zero crossings %d, want %d ±10%%", zOut, zIn)
			}
		})
	}
}

func FuzzDecode(f *testing.F) {
	enc, err := NewEncoder()
	if err != nil {
		f.Fatal(err)
	}
	valid, err := enc.Encode(make([]byte, FrameBytes))
	if err != nil {
		f.Fatal(err)
	}
	f.Add(valid)
	f.Add([]byte{})
	f.Add([]byte{0x00})
	f.Add([]byte{0xFF})
	f.Add([]byte{0xFF, 0x00})
	dec, err := NewDecoder()
	if err != nil {
		f.Fatal(err)
	}
	f.Fuzz(func(t *testing.T, packet []byte) {
		pcm, err := dec.Decode(packet)
		if err != nil {
			if pcm != nil {
				t.Fatal("Decode returned both pcm and error")
			}
			return
		}
		if len(pcm)%2 != 0 {
			t.Fatalf("decoded %d bytes, not sample-aligned", len(pcm))
		}
		samples := len(pcm) / 2
		if samples <= 0 || samples > maxDecodeSamples || samples%120 != 0 {
			t.Fatalf("decoded %d samples, not a legal packet duration", samples)
		}
	})
}
