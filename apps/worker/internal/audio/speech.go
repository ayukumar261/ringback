package audio

import (
	"encoding/binary"
	"time"
)

const (
	speechOpenFrames  = 3  // require 60 ms of voice before opening a segment
	speechQuietFrames = 10 // join pauses shorter than 200 ms
	speechOpenPower   = 300.0 * 300.0
	speechKeepPower   = 200.0 * 200.0
)

// SpeechSegment holds offsets into the recording, with an exclusive end.
type SpeechSegment struct {
	Started time.Duration
	Ended   time.Duration
}

// VoiceDetector classifies one 20 ms caller frame. Active allows a lower
// threshold during speech. A WebRTC VAD can implement this without changing
// the segment clock, echo check, or transcript handling.
type VoiceDetector interface {
	IsSpeech(pcm []byte, active bool) bool
}

// energyVoice adapts to quiet-line energy and freezes its noise estimate during
// speech. The initial thresholds are heuristics to validate on real calls.
type energyVoice struct {
	noise float64
}

func (v *energyVoice) IsSpeech(pcm []byte, active bool) bool {
	power := framePower(pcm)
	threshold := max(speechOpenPower, 9*v.noise)
	if active {
		threshold = max(speechKeepPower, 4*v.noise)
	}
	voiced := power > threshold
	if !active && !voiced {
		v.noise += 0.05 * (power - v.noise)
	}
	return voiced
}

// framePower measures mean squared 16-bit PCM amplitude. Like Interleave, it
// pads short frames with silence and ignores samples past the playout frame.
func framePower(pcm []byte) float64 {
	var sum float64
	for i := 0; i+1 < min(len(pcm), FrameBytes); i += 2 {
		sample := float64(int16(binary.LittleEndian.Uint16(pcm[i:])))
		sum += sample * sample
	}
	return sum / FrameSamples
}

// SpeechDetector groups caller voice into segments using only recorded frames;
// it performs no I/O and reads no wall clock. The owner serializes access.
type SpeechDetector struct {
	voice   VoiceDetector
	frames  int64
	pending int
	quiet   int
	open    bool
	start   int64
	end     int64
	closed  []SpeechSegment
}

// NewSpeechDetector uses an energy detector unless a replacement is supplied.
func NewSpeechDetector(voice VoiceDetector) *SpeechDetector {
	if voice == nil {
		voice = &energyVoice{noise: 100 * 100}
	}
	return &SpeechDetector{voice: voice}
}

// Record observes exactly the caller and agent samples written on one tick.
func (d *SpeechDetector) Record(caller, agent []byte) {
	agentPower := framePower(agent)
	echoMargin := 4.0 // caller must exceed agent RMS by 2x to open
	if d.open {
		echoMargin = 2.0
	}
	echo := agentPower > speechOpenPower && framePower(caller) <= echoMargin*agentPower
	// Do not train the quiet-line noise floor on the agent's echo.
	voiced := !echo && d.voice.IsSpeech(caller, d.open)
	if voiced {
		if !d.open {
			if d.pending == 0 {
				d.start = d.frames
			}
			d.pending++
			if d.pending >= speechOpenFrames {
				d.open = true
			}
		}
		d.end = d.frames + 1
		d.quiet = 0
	} else if d.open {
		d.quiet++
		if d.quiet >= speechQuietFrames {
			// Backdate the end to the last voiced frame, excluding the hangover.
			d.close(d.end)
		}
	} else {
		d.pending = 0
	}
	d.frames++
}

// Take returns segments since the previous transcript and consumes them. An
// open segment closes at the current recording position; a later transcript
// can only claim frames recorded after this call.
func (d *SpeechDetector) Take() []SpeechSegment {
	if d.open {
		d.close(d.frames)
	}
	d.pending = 0
	segments := d.closed
	d.closed = nil
	return segments
}

func (d *SpeechDetector) close(end int64) {
	d.closed = append(d.closed, SpeechSegment{
		Started: time.Duration(d.start) * FrameDuration,
		Ended:   time.Duration(end) * FrameDuration,
	})
	d.open = false
	d.pending = 0
	d.quiet = 0
}
