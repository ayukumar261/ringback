package room

import (
	"log/slog"
	"sync"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
	"github.com/ayukumar261/ringback/apps/worker/internal/wav"
)

// tap records what each side heard as one stereo frame per playout tick.
type tap struct {
	log *slog.Logger
	w   *wav.Writer

	mu      sync.Mutex
	caller  []byte // the latest decoded caller frame, nil once the tick takes it
	stopped bool   // set after a write error so the call outlives the recording
}

// newTap wraps a writer whose left channel is the caller and right channel the agent.
func newTap(w *wav.Writer, log *slog.Logger) *tap {
	return &tap{log: log, w: w}
}

// offer replaces the slot with the newest caller frame so the tick records the latest one.
func (t *tap) offer(pcm []byte) {
	if t == nil {
		return
	}
	t.mu.Lock()
	t.caller = pcm
	t.mu.Unlock()
}

// record takes the caller slot and writes it beside the agent frame, going quiet after a write error.
func (t *tap) record(agent []byte) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	caller := t.caller
	t.caller = nil
	if t.stopped {
		return
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
