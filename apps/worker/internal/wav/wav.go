// Package wav reads mono 16-bit PCM wav files and writes mono or multichannel ones.
package wav

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
)

// Read loads a mono 16 bit PCM wav and returns its samples and rate.
func Read(path string) ([]byte, int, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, err
	}
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return nil, 0, fmt.Errorf("%s is not a wav file", path)
	}
	var rate int
	var data []byte
	off := 12
	for off+8 <= len(b) {
		id := string(b[off : off+4])
		size := int(binary.LittleEndian.Uint32(b[off+4 : off+8]))
		body := b[off+8:]
		if size > len(body) {
			return nil, 0, fmt.Errorf("%s has a truncated %q chunk", path, id)
		}
		body = body[:size]
		switch id {
		case "fmt ":
			if len(body) < 16 {
				return nil, 0, fmt.Errorf("%s has a short fmt chunk", path)
			}
			if f := binary.LittleEndian.Uint16(body[0:2]); f != 1 {
				return nil, 0, fmt.Errorf("%s is not raw PCM", path)
			}
			if ch := binary.LittleEndian.Uint16(body[2:4]); ch != 1 {
				return nil, 0, fmt.Errorf("%s must be mono", path)
			}
			if bits := binary.LittleEndian.Uint16(body[14:16]); bits != 16 {
				return nil, 0, fmt.Errorf("%s must be 16 bit", path)
			}
			rate = int(binary.LittleEndian.Uint32(body[4:8]))
		case "data":
			data = body
		}
		off += 8 + size + size%2
	}
	if rate == 0 || data == nil {
		return nil, 0, fmt.Errorf("%s is missing its fmt or data chunk", path)
	}
	return data, rate, nil
}

// Write saves mono 16 bit PCM samples as a wav file.
func Write(path string, pcm []byte, rate int) error {
	return os.WriteFile(path, append(header(rate, 1, len(pcm)), pcm...), 0o644)
}

// header builds the 44 byte RIFF, fmt and data prefix for 16 bit PCM.
func header(rate, channels, dataLen int) []byte {
	var buf bytes.Buffer
	buf.WriteString("RIFF")
	binary.Write(&buf, binary.LittleEndian, uint32(36+dataLen))
	buf.WriteString("WAVEfmt ")
	binary.Write(&buf, binary.LittleEndian, uint32(16))
	binary.Write(&buf, binary.LittleEndian, uint16(1))
	binary.Write(&buf, binary.LittleEndian, uint16(channels))
	binary.Write(&buf, binary.LittleEndian, uint32(rate))
	binary.Write(&buf, binary.LittleEndian, uint32(rate*channels*2))
	binary.Write(&buf, binary.LittleEndian, uint16(channels*2))
	binary.Write(&buf, binary.LittleEndian, uint16(16))
	buf.WriteString("data")
	binary.Write(&buf, binary.LittleEndian, uint32(dataLen))
	return buf.Bytes()
}

// Writer appends interleaved 16 bit PCM frames to a wav file as they arrive.
type Writer struct {
	f        *os.File
	channels int
	n        int
}

// NewWriter creates the file and writes a header whose sizes Close fills in.
func NewWriter(path string, rate, channels int) (*Writer, error) {
	if channels < 1 {
		return nil, fmt.Errorf("wav: channels must be at least 1, got %d", channels)
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(header(rate, channels, 0)); err != nil {
		f.Close()
		return nil, err
	}
	return &Writer{f: f, channels: channels}, nil
}

// Write appends one or more interleaved frames of 16 bit samples.
func (w *Writer) Write(pcm []byte) error {
	if len(pcm)%(w.channels*2) != 0 {
		return fmt.Errorf("wav: frame must be a multiple of %d bytes, got %d", w.channels*2, len(pcm))
	}
	n, err := w.f.Write(pcm)
	w.n += n
	return err
}

// Close patches the RIFF and data sizes then closes the file.
func (w *Writer) Close() error {
	err := w.patch(4, uint32(36+w.n))
	if err == nil {
		err = w.patch(40, uint32(w.n))
	}
	if cerr := w.f.Close(); err == nil {
		err = cerr
	}
	return err
}

// patch overwrites one little endian size field at the given offset.
func (w *Writer) patch(off int64, v uint32) error {
	var b [4]byte
	binary.LittleEndian.PutUint32(b[:], v)
	_, err := w.f.WriteAt(b[:], off)
	return err
}
