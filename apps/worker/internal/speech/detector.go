// Package speech detects caller speech on the recording clock.
package speech

import (
	"fmt"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

const (
	speechMinVoice    = 64 * time.Millisecond
	speechQuiet       = 200 * time.Millisecond
	speechPad         = 32 * time.Millisecond
	maxSpeechSegments = 256
)

// Segment holds offsets into the recording, with an exclusive end.
type Segment struct{ Started, Ended time.Duration }

// VoiceFrame describes a classified interval in the original WAV, after
// compensating for DSP delay. Intervals must be contiguous and ordered.
type VoiceFrame struct {
	Started, Ended time.Duration
	Probability    float64
}

// VoiceDetector owns its resampling, echo processing, and inference state.
// Process consumes exactly one recorded 48 kHz, 20 ms stereo pair; it may buffer
// input. Flush drains that buffer at hangup, never at a live transcript boundary.
type VoiceDetector interface {
	Process(caller, agent []byte) ([]VoiceFrame, error)
	Flush() ([]VoiceFrame, error)
	Close()
}

// Detector groups probabilities on the recording clock. Its owner must
// serialize access; production uses Analyzer to keep native work off the
// recording goroutine. Any failure invalidates unclaimed timestamps.
type Detector struct {
	voice                       VoiceDetector
	err                         error
	recorded, frontier, claimed time.Duration
	onset, voiced, lastVoice    time.Duration
	open                        bool
	segments                    []Segment
	finished                    bool
}

func NewDetector(voice VoiceDetector) *Detector {
	d := &Detector{voice: voice}
	if d.voice == nil {
		d.voice, d.err = newSileroVoice()
	}
	return d
}

func (d *Detector) Err() error { return d.err }

func (d *Detector) Record(caller, agent []byte) {
	if d.err != nil || d.finished {
		return
	}
	d.recorded += audio.FrameDuration
	frames, err := d.voice.Process(caller, agent)
	d.accept(frames, err)
}

func (d *Detector) accept(frames []VoiceFrame, err error) {
	if err != nil {
		d.err = err
		return
	}
	for _, f := range frames {
		if f.Started != d.frontier || f.Ended <= f.Started || f.Ended > d.recorded || !(f.Probability >= 0 && f.Probability <= 1) {
			d.err = fmt.Errorf("speech: invalid inference interval %+v after %v (recorded %v)", f, d.frontier, d.recorded)
			return
		}
		d.frontier = f.Ended
		threshold := 0.5
		if d.open {
			threshold = 0.35
		}
		if f.Probability >= threshold {
			if d.voiced == 0 {
				d.onset = max(d.claimed, f.Started-speechPad)
			}
			d.voiced += f.Ended - f.Started
			d.lastVoice = f.Ended
			if d.voiced >= speechMinVoice {
				d.open = true
			}
		} else if d.open {
			if f.Ended-d.lastVoice >= speechQuiet {
				d.endSegment(d.lastVoice)
			}
		} else {
			d.voiced = 0
		}
	}
}

func (d *Detector) endSegment(end time.Duration) {
	if d.onset < end {
		d.segments = append(d.segments, Segment{d.onset, end})
	}
	if len(d.segments) > maxSpeechSegments {
		d.err = fmt.Errorf("speech: unclaimed segment limit exceeded")
	}
	d.open, d.voiced = false, 0
}

// Finish drains inference without extending the recording, then releases native
// resources. Segments remain available for delayed transcripts after hangup.
func (d *Detector) Finish() {
	if d.finished {
		return
	}
	d.finished = true
	if d.voice == nil {
		return
	}
	defer d.voice.Close()
	if d.err != nil {
		return
	}
	frames, err := d.voice.Flush()
	d.accept(frames, err)
	if d.err == nil && d.frontier != d.recorded {
		d.err = fmt.Errorf("speech: incomplete final inference")
	}
}

// Take consumes up to the processed frontier. Production waits for inference to
// cover the transcript's recorded cutoff before calling takeAt.
func (d *Detector) Take() []Segment { return d.takeAt(d.frontier) }

func (d *Detector) takeAt(cutoff time.Duration) []Segment {
	if d.err != nil || cutoff <= d.claimed {
		return nil
	}
	var result, keep []Segment
	for _, s := range d.segments {
		if s.Started < cutoff {
			result = append(result, Segment{s.Started, min(s.Ended, cutoff)})
		}
		if s.Ended > cutoff {
			keep = append(keep, Segment{max(s.Started, cutoff), s.Ended})
		}
	}
	d.segments = keep
	if d.open && d.onset < cutoff {
		result = append(result, Segment{d.onset, cutoff})
		d.onset = cutoff
		if d.lastVoice <= cutoff {
			d.open, d.voiced = false, 0
		}
	} else if !d.open {
		// Unconfirmed audio before this transcript cannot belong to the next one.
		d.onset = max(d.onset, cutoff)
		d.voiced = min(d.voiced, max(0, d.lastVoice-cutoff))
	}
	d.claimed = cutoff
	return result
}
