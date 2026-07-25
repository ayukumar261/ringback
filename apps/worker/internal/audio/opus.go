package audio

import (
	"bytes"
	"fmt"

	"gopkg.in/hraban/opus.v2"
)

// Encoder turns 20 ms frames of raw PCM into Opus packets and is not safe for concurrent use.
type Encoder struct {
	enc    *opus.Encoder
	pcm    []int16
	packet []byte
}

// NewEncoder returns an Opus encoder fixed at 48 kHz mono voice.
func NewEncoder() (*Encoder, error) {
	enc, err := opus.NewEncoder(SampleRate, Channels, opus.AppVoIP)
	if err != nil {
		return nil, fmt.Errorf("audio: new encoder: %w", err)
	}
	return &Encoder{
		enc:    enc,
		pcm:    make([]int16, FrameSamples),
		packet: make([]byte, maxPacketBytes),
	}, nil
}

// Encode compresses exactly one 1920-byte PCM frame into a fresh Opus packet.
func (e *Encoder) Encode(pcm []byte) ([]byte, error) {
	if len(pcm) != FrameBytes {
		return nil, fmt.Errorf("audio: encode: frame must be %d bytes, got %d", FrameBytes, len(pcm))
	}
	e.pcm = pcmToInt16(pcm, e.pcm)
	n, err := e.enc.Encode(e.pcm, e.packet)
	if err != nil {
		return nil, fmt.Errorf("audio: encode: %w", err)
	}
	return bytes.Clone(e.packet[:n]), nil
}

// Decoder turns Opus packets into raw PCM and is not safe for concurrent use.
type Decoder struct {
	dec *opus.Decoder
	pcm []int16
}

// NewDecoder returns an Opus decoder fixed at 48 kHz mono.
func NewDecoder() (*Decoder, error) {
	dec, err := opus.NewDecoder(SampleRate, Channels)
	if err != nil {
		return nil, fmt.Errorf("audio: new decoder: %w", err)
	}
	return &Decoder{
		dec: dec,
		pcm: make([]int16, maxDecodeSamples),
	}, nil
}

// Decode expands one Opus packet into a fresh slice of PCM bytes.
func (d *Decoder) Decode(packet []byte) ([]byte, error) {
	if len(packet) == 0 {
		return nil, fmt.Errorf("audio: decode: empty packet")
	}
	n, err := d.dec.Decode(packet, d.pcm)
	if err != nil {
		return nil, fmt.Errorf("audio: decode: %w", err)
	}
	return int16ToPCM(d.pcm[:n]), nil
}
