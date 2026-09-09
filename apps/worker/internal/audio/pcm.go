package audio

import (
	"encoding/binary"
	"math"
)

// pcmToInt16 converts little-endian PCM bytes into samples, reusing dst when it fits.
func pcmToInt16(b []byte, dst []int16) []int16 {
	n := len(b) / 2
	if cap(dst) < n {
		dst = make([]int16, n)
	}
	dst = dst[:n]
	for i := range dst {
		dst[i] = int16(binary.LittleEndian.Uint16(b[2*i:]))
	}
	return dst
}

// int16ToPCM converts samples into fresh little-endian PCM bytes.
func int16ToPCM(s []int16) []byte {
	b := make([]byte, 2*len(s))
	for i, v := range s {
		binary.LittleEndian.PutUint16(b[2*i:], uint16(v))
	}
	return b
}

// Interleave pairs left and right into one stereo frame, padding either side with silence past its samples.
func Interleave(left, right []byte) []byte {
	out := make([]byte, 2*FrameBytes)
	for i := range FrameSamples {
		if len(left) >= 2*i+2 {
			out[4*i], out[4*i+1] = left[2*i], left[2*i+1]
		}
		if len(right) >= 2*i+2 {
			out[4*i+2], out[4*i+3] = right[2*i], right[2*i+1]
		}
	}
	return out
}

// Mix sums a and b sample by sample into a fresh frame as long as the longer input, clamping so loud peaks do not wrap.
func Mix(a, b []byte) []byte {
	out := make([]byte, max(len(a), len(b)))
	for i := 0; 2*i+2 <= len(out); i++ {
		var v int32
		if 2*i+2 <= len(a) {
			v += int32(int16(binary.LittleEndian.Uint16(a[2*i:])))
		}
		if 2*i+2 <= len(b) {
			v += int32(int16(binary.LittleEndian.Uint16(b[2*i:])))
		}
		v = max(math.MinInt16, min(math.MaxInt16, v))
		binary.LittleEndian.PutUint16(out[2*i:], uint16(int16(v)))
	}
	return out
}
