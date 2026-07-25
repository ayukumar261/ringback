package audio

import (
	"bytes"
	"sync"
	"testing"
	"time"
)

// pattern returns n deterministic non-silence bytes for buffer tests.
func pattern(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*7 + 3)
	}
	return b
}

var silence = make([]byte, FrameBytes)

func TestReadFrameEmptyIsSilence(t *testing.T) {
	b := NewPlayoutBuffer()
	for i := 0; i < 2; i++ {
		if f := b.ReadFrame(); !bytes.Equal(f, silence) {
			t.Fatalf("read %d: empty buffer returned non-silence", i)
		}
	}
	if d := b.Buffered(); d != 0 {
		t.Fatalf("Buffered() = %v, want 0", d)
	}
}

func TestPushExactFrame(t *testing.T) {
	b := NewPlayoutBuffer()
	p := pattern(FrameBytes)
	b.Push(p)
	if d := b.Buffered(); d != FrameDuration {
		t.Fatalf("Buffered() = %v, want %v", d, FrameDuration)
	}
	if f := b.ReadFrame(); !bytes.Equal(f, p) {
		t.Fatal("frame does not match pushed bytes")
	}
	if d := b.Buffered(); d != 0 {
		t.Fatalf("Buffered() after drain = %v, want 0", d)
	}
	if f := b.ReadFrame(); !bytes.Equal(f, silence) {
		t.Fatal("drained buffer returned non-silence")
	}
}

func TestPushSpansReads(t *testing.T) {
	b := NewPlayoutBuffer()
	p := pattern(2000)
	b.Push(p[:1000])
	b.Push(p[1000:])
	if f := b.ReadFrame(); !bytes.Equal(f, p[:FrameBytes]) {
		t.Fatal("frame 1 does not span the push boundary")
	}
	want := make([]byte, FrameBytes)
	copy(want, p[FrameBytes:])
	if f := b.ReadFrame(); !bytes.Equal(f, want) {
		t.Fatal("frame 2 is not tail plus silence padding")
	}
}

func TestPartialTailPadded(t *testing.T) {
	b := NewPlayoutBuffer()
	p := pattern(FrameBytes + 700)
	b.Push(p)
	if f := b.ReadFrame(); !bytes.Equal(f, p[:FrameBytes]) {
		t.Fatal("frame 1 mismatch")
	}
	want := make([]byte, FrameBytes)
	copy(want, p[FrameBytes:])
	if f := b.ReadFrame(); !bytes.Equal(f, want) {
		t.Fatal("partial tail was not padded with silence")
	}
	if d := b.Buffered(); d != 0 {
		t.Fatalf("Buffered() = %v, want 0 after consuming tail", d)
	}
}

func TestBurstDrainExact(t *testing.T) {
	const burst = 240000
	b := NewPlayoutBuffer()
	p := pattern(burst)
	b.Push(p)
	if d := b.Buffered(); d != 2500*time.Millisecond {
		t.Fatalf("Buffered() = %v, want 2.5s", d)
	}
	got := make([]byte, 0, burst)
	for i := 0; i < burst/FrameBytes; i++ {
		got = append(got, b.ReadFrame()...)
	}
	if !bytes.Equal(got, p) {
		t.Fatal("drained frames do not reassemble the burst byte-for-byte")
	}
	if f := b.ReadFrame(); !bytes.Equal(f, silence) {
		t.Fatal("buffer not silent after full drain")
	}
}

func TestFlush(t *testing.T) {
	b := NewPlayoutBuffer()
	b.Push(pattern(5000))
	b.Flush()
	if d := b.Buffered(); d != 0 {
		t.Fatalf("Buffered() after Flush = %v, want 0", d)
	}
	if f := b.ReadFrame(); !bytes.Equal(f, silence) {
		t.Fatal("Flush left audio behind")
	}
	b.Flush()
	p := pattern(FrameBytes)
	b.Push(p)
	if f := b.ReadFrame(); !bytes.Equal(f, p) {
		t.Fatal("buffer unusable after Flush")
	}
}

func TestPushDoesNotAliasCaller(t *testing.T) {
	b := NewPlayoutBuffer()
	src := pattern(FrameBytes)
	want := bytes.Clone(src)
	b.Push(src)
	for i := range src {
		src[i] = 0xEE
	}
	if f := b.ReadFrame(); !bytes.Equal(f, want) {
		t.Fatal("mutating the pushed slice changed queued audio")
	}
}

func TestReadFrameReturnsFreshSlice(t *testing.T) {
	b := NewPlayoutBuffer()
	p := pattern(2 * FrameBytes)
	b.Push(p)
	f1 := b.ReadFrame()
	for i := range f1 {
		f1[i] = 0xEE
	}
	if f2 := b.ReadFrame(); !bytes.Equal(f2, p[FrameBytes:]) {
		t.Fatal("mutating a returned frame changed queued audio")
	}
}

func TestBuffered(t *testing.T) {
	for _, tt := range []struct {
		name  string
		bytes int
		want  time.Duration
	}{
		{"empty", 0, 0},
		{"half frame", 960, 10 * time.Millisecond},
		{"one frame", FrameBytes, FrameDuration},
		{"burst", 240000, 2500 * time.Millisecond},
		{"single sample", 3, time.Second / SampleRate},
	} {
		t.Run(tt.name, func(t *testing.T) {
			b := NewPlayoutBuffer()
			b.Push(make([]byte, tt.bytes))
			if d := b.Buffered(); d != tt.want {
				t.Fatalf("Buffered() = %v, want %v", d, tt.want)
			}
		})
	}
}

func TestConcurrentPushReadFlush(t *testing.T) {
	b := NewPlayoutBuffer()
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			size := int(uint32(i)*2654435761%4096) + 1
			b.Push(make([]byte, size))
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 500; i++ {
			if f := b.ReadFrame(); len(f) != FrameBytes {
				t.Errorf("ReadFrame returned %d bytes", len(f))
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 20; i++ {
			b.Flush()
			_ = b.Buffered()
		}
	}()
	wg.Wait()
}
