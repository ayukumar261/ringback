package wav

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// stereoFrame returns one 20 ms interleaved frame with a distinct tone on each side.
func stereoFrame(i int) []byte {
	b := make([]byte, 960*4)
	for s := 0; s < 960; s++ {
		binary.LittleEndian.PutUint16(b[s*4:], uint16(int16(i*1000+s)))
		binary.LittleEndian.PutUint16(b[s*4+2:], uint16(int16(-(i*1000 + s))))
	}
	return b
}

func TestWriterStereoRoundTrip(t *testing.T) {
	const n = 50
	path := filepath.Join(t.TempDir(), "call.wav")
	w, err := NewWriter(path, 48000, 2)
	if err != nil {
		t.Fatalf("NewWriter() = %v", err)
	}
	var want []byte
	for i := 0; i < n; i++ {
		f := stereoFrame(i)
		if err := w.Write(f); err != nil {
			t.Fatalf("Write(%d) = %v", i, err)
		}
		want = append(want, f...)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close() = %v", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) != 44+len(want) {
		t.Fatalf("file is %d bytes, want %d", len(b), 44+len(want))
	}
	u16 := func(off int) int { return int(binary.LittleEndian.Uint16(b[off:])) }
	u32 := func(off int) int { return int(binary.LittleEndian.Uint32(b[off:])) }
	checks := []struct {
		name      string
		got, want int
	}{
		{"riff size", u32(4), 36 + len(want)},
		{"fmt size", u32(16), 16},
		{"format", u16(20), 1},
		{"channels", u16(22), 2},
		{"rate", u32(24), 48000},
		{"byte rate", u32(28), 192000},
		{"block align", u16(32), 4},
		{"bits", u16(34), 16},
		{"data size", u32(40), len(want)},
	}
	if string(b[0:4]) != "RIFF" || string(b[8:16]) != "WAVEfmt " || string(b[36:40]) != "data" {
		t.Errorf("chunk ids are wrong: %q %q %q", b[0:4], b[8:16], b[36:40])
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("%s = %d, want %d", c.name, c.got, c.want)
		}
	}
	if !bytes.Equal(b[44:], want) {
		t.Error("data bytes do not match the frames written")
	}
	if _, _, err := Read(path); err == nil {
		t.Error("Read() accepted a stereo file")
	}
}

func TestWriterMonoMatchesRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mono.wav")
	w, err := NewWriter(path, 48000, 1)
	if err != nil {
		t.Fatalf("NewWriter() = %v", err)
	}
	var want []byte
	for i := 0; i < 5; i++ {
		f := stereoFrame(i)[:1920]
		if err := w.Write(f); err != nil {
			t.Fatalf("Write(%d) = %v", i, err)
		}
		want = append(want, f...)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close() = %v", err)
	}
	got, rate, err := Read(path)
	if err != nil {
		t.Fatalf("Read() = %v", err)
	}
	if rate != 48000 {
		t.Errorf("rate = %d, want 48000", rate)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("Read() returned %d bytes that differ from the %d written", len(got), len(want))
	}
}

func TestWriterRejectsPartialFrame(t *testing.T) {
	w, err := NewWriter(filepath.Join(t.TempDir(), "bad.wav"), 48000, 2)
	if err != nil {
		t.Fatalf("NewWriter() = %v", err)
	}
	defer w.Close()
	if err := w.Write(make([]byte, 3)); err == nil {
		t.Error("Write() accepted 3 bytes for a 4 byte frame")
	}
	if _, err := NewWriter(filepath.Join(t.TempDir(), "zero.wav"), 48000, 0); err == nil {
		t.Error("NewWriter() accepted 0 channels")
	}
}
