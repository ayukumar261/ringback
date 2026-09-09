package audio

import (
	"math"
	"time"
	"unicode"
)

const (
	// DTMFDuration is how long one synthesized key press sounds in the recording.
	DTMFDuration = 100 * time.Millisecond
	// DTMFSamples is the sample count of one synthesized key press.
	DTMFSamples = int(DTMFDuration * SampleRate / time.Second)
	// dtmfAmplitude is the peak of each sine so the pair stays well inside int16.
	dtmfAmplitude = 6000
)

// dtmfFreqs maps each key to its low row frequency and high column frequency in Hz.
var dtmfFreqs = map[rune][2]float64{
	'1': {697, 1209}, '2': {697, 1336}, '3': {697, 1477}, 'A': {697, 1633},
	'4': {770, 1209}, '5': {770, 1336}, '6': {770, 1477}, 'B': {770, 1633},
	'7': {852, 1209}, '8': {852, 1336}, '9': {852, 1477}, 'C': {852, 1633},
	'*': {941, 1209}, '0': {941, 1336}, '#': {941, 1477}, 'D': {941, 1633},
}

// DTMFTone returns one key press as 100 ms of PCM made of the key's two sines, or nil for a key with no tone.
func DTMFTone(key rune) []byte {
	f, ok := dtmfFreqs[unicode.ToUpper(key)]
	if !ok {
		return nil
	}
	s := make([]int16, DTMFSamples)
	for i := range s {
		t := float64(i) / SampleRate
		s[i] = int16(dtmfAmplitude * (math.Sin(2*math.Pi*f[0]*t) + math.Sin(2*math.Pi*f[1]*t)))
	}
	return int16ToPCM(s)
}
