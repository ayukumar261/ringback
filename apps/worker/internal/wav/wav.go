// Package wav reads and writes mono 16-bit PCM wav files.
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
	var buf bytes.Buffer
	buf.WriteString("RIFF")
	binary.Write(&buf, binary.LittleEndian, uint32(36+len(pcm)))
	buf.WriteString("WAVEfmt ")
	binary.Write(&buf, binary.LittleEndian, uint32(16))
	binary.Write(&buf, binary.LittleEndian, uint16(1))
	binary.Write(&buf, binary.LittleEndian, uint16(1))
	binary.Write(&buf, binary.LittleEndian, uint32(rate))
	binary.Write(&buf, binary.LittleEndian, uint32(rate*2))
	binary.Write(&buf, binary.LittleEndian, uint16(2))
	binary.Write(&buf, binary.LittleEndian, uint16(16))
	buf.WriteString("data")
	binary.Write(&buf, binary.LittleEndian, uint32(len(pcm)))
	buf.Write(pcm)
	return os.WriteFile(path, buf.Bytes(), 0o644)
}
