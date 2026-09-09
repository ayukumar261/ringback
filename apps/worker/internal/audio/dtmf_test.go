package audio

import (
	"math"
	"testing"
)

// goertzel returns the relative power of freq in pcm so a test can tell which sines are present.
func goertzel(pcm []byte, freq float64) float64 {
	s := pcmToInt16(pcm, nil)
	w := 2 * math.Pi * freq / SampleRate
	coeff := 2 * math.Cos(w)
	var q0, q1, q2 float64
	for _, v := range s {
		q0 = coeff*q1 - q2 + float64(v)
		q2 = q1
		q1 = q0
	}
	return (q1*q1 + q2*q2 - q1*q2*coeff) / float64(len(s))
}

// dtmfRows and dtmfCols are the eight standard frequencies every key is built from.
var (
	dtmfRows = []float64{697, 770, 852, 941}
	dtmfCols = []float64{1209, 1336, 1477, 1633}
)

func TestDTMFToneFrequencies(t *testing.T) {
	keys := [4][4]rune{
		{'1', '2', '3', 'A'},
		{'4', '5', '6', 'B'},
		{'7', '8', '9', 'C'},
		{'*', '0', '#', 'D'},
	}
	for ri, row := range keys {
		for ci, key := range row {
			t.Run(string(key), func(t *testing.T) {
				pcm := DTMFTone(key)
				if len(pcm) != 2*DTMFSamples {
					t.Fatalf("tone is %d bytes, want %d", len(pcm), 2*DTMFSamples)
				}
				if e := rms(pcm); e < 3000 {
					t.Errorf("rms %.0f, want an audible tone", e)
				}
				wantLow, wantHigh := goertzel(pcm, dtmfRows[ri]), goertzel(pcm, dtmfCols[ci])
				for _, f := range append(append([]float64{}, dtmfRows...), dtmfCols...) {
					if f == dtmfRows[ri] || f == dtmfCols[ci] {
						continue
					}
					if p := goertzel(pcm, f); p*100 > wantLow || p*100 > wantHigh {
						t.Errorf("%.0f Hz has power %.0f, want far below %.0f and %.0f", f, p, wantLow, wantHigh)
					}
				}
			})
		}
	}
}

func TestDTMFToneStaysInsideInt16(t *testing.T) {
	for _, key := range "0123456789*#ABCD" {
		for _, v := range pcmToInt16(DTMFTone(key), nil) {
			if v > 2*dtmfAmplitude || v < -2*dtmfAmplitude {
				t.Fatalf("key %q has sample %d outside the two sine peak", key, v)
			}
		}
	}
}

func TestDTMFToneLowercaseLetters(t *testing.T) {
	for _, key := range "abcd" {
		if DTMFTone(key) == nil {
			t.Errorf("key %q has no tone, want the uppercase key's tone", key)
		}
	}
}

func TestDTMFToneUnknownKeyIsNil(t *testing.T) {
	for _, key := range "w, xE" {
		if pcm := DTMFTone(key); pcm != nil {
			t.Errorf("key %q returned %d bytes, want nil", key, len(pcm))
		}
	}
}
