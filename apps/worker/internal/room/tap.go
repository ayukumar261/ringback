package room

import (
	"log/slog"
	"sync"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
	"github.com/ayukumar261/ringback/apps/worker/internal/wav"
)

// callerQueueCap bounds how many caller frames wait for a tick before the oldest is dropped.
const callerQueueCap = 4

// tap records what each side heard as one stereo frame per playout tick.
type tap struct {
	log *slog.Logger
	w   *wav.Writer

	mu      sync.Mutex
	caller  [][]byte // decoded caller frames waiting for a tick, oldest first
	tone    []byte   // key press audio still waiting to be mixed into the agent channel
	stopped bool     // set after a write error so the call outlives the recording
}

// newTap wraps a writer whose left channel is the caller and right channel the agent.
func newTap(w *wav.Writer, log *slog.Logger) *tap {
	return &tap{log: log, w: w}
}

// offer appends a caller frame to the queue, dropping the oldest once the cap is reached.
func (t *tap) offer(pcm []byte) {
	if t == nil {
		return
	}
	t.mu.Lock()
	if len(t.caller) == callerQueueCap {
		t.pop()
	}
	t.caller = append(t.caller, pcm)
	t.mu.Unlock()
}

// pop removes and returns the oldest queued caller frame, or nil when the queue is empty.
func (t *tap) pop() []byte {
	if len(t.caller) == 0 {
		return nil
	}
	oldest := t.caller[0]
	last := len(t.caller) - 1
	copy(t.caller, t.caller[1:])
	t.caller[last] = nil
	t.caller = t.caller[:last]
	return oldest
}

// press queues the beep for key so the next ticks mix it into the agent channel of the recording only.
func (t *tap) press(key rune) {
	if t == nil {
		return
	}
	pcm := audio.DTMFTone(key)
	if pcm == nil {
		return
	}
	t.mu.Lock()
	if !t.stopped {
		t.tone = append(t.tone, pcm...)
	}
	t.mu.Unlock()
}

// record pops the oldest caller frame and writes it beside the agent frame, going quiet after a write error.
func (t *tap) record(agent []byte) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	caller := t.pop()
	if t.stopped {
		return
	}
	if len(t.tone) > 0 {
		n := min(len(t.tone), audio.FrameBytes)
		agent = audio.Mix(agent, t.tone[:n])
		t.tone = t.tone[n:]
		if len(t.tone) == 0 {
			t.tone = nil
		}
	}
	if err := t.w.Write(audio.Interleave(caller, agent)); err != nil {
		t.stopped = true
		t.log.Warn("stopping call audio recording", "err", err)
	}
}

// close patches the wav header and closes the file.
func (t *tap) close() error {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.w.Close()
}
