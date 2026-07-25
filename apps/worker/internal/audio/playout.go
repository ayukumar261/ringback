package audio

import (
	"sync"
	"time"
)

// PlayoutBuffer queues agent PCM and hands it out one 20 ms frame at a time.
type PlayoutBuffer struct {
	mu  sync.Mutex
	buf []byte
	off int
}

// NewPlayoutBuffer returns an empty playout buffer.
func NewPlayoutBuffer() *PlayoutBuffer {
	return &PlayoutBuffer{}
}

// Push copies pcm onto the end of the queue.
func (b *PlayoutBuffer) Push(pcm []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.off > 0 {
		n := copy(b.buf, b.buf[b.off:])
		b.buf = b.buf[:n]
		b.off = 0
	}
	b.buf = append(b.buf, pcm...)
}

// ReadFrame pops the next 1920-byte frame, padding with silence when the queue runs short.
func (b *PlayoutBuffer) ReadFrame() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	frame := make([]byte, FrameBytes)
	b.off += copy(frame, b.buf[b.off:])
	if b.off == len(b.buf) {
		b.buf = b.buf[:0]
		b.off = 0
	}
	return frame
}

// Flush discards all queued audio.
func (b *PlayoutBuffer) Flush() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = b.buf[:0]
	b.off = 0
}

// Buffered reports the queued audio as playout time.
func (b *PlayoutBuffer) Buffered() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	samples := (len(b.buf) - b.off) / 2
	return time.Duration(samples) * time.Second / SampleRate
}
