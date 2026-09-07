package audio

import "encoding/binary"

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
