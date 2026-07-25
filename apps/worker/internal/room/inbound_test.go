package room

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"math"
	"testing"
	"time"

	"github.com/pion/rtp"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

const (
	lowHz  = 440  // ~18 zero crossings per 20 ms frame
	highHz = 1760 // ~70 zero crossings per 20 ms frame
)

// discard is a logger for paths whose output the tests do not assert on.
var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

// toneFrame returns one 20 ms frame of a loud sine at freq.
func toneFrame(freq float64) []byte {
	frame := make([]byte, audio.FrameBytes)
	for i := 0; i < audio.FrameSamples; i++ {
		s := int16(8000 * math.Sin(2*math.Pi*freq*float64(i)/audio.SampleRate))
		binary.LittleEndian.PutUint16(frame[2*i:], uint16(s))
	}
	return frame
}

// rms measures a PCM frame's energy in int16 units.
func rms(pcm []byte) float64 {
	var sum float64
	n := len(pcm) / 2
	for i := 0; i < n; i++ {
		s := float64(int16(binary.LittleEndian.Uint16(pcm[2*i:])))
		sum += s * s
	}
	return math.Sqrt(sum / float64(n))
}

// crossings counts sign changes, a codec-proof stand-in for pitch.
func crossings(pcm []byte) int {
	var n, prev int
	for i := 0; i < len(pcm)/2; i++ {
		s := int(int16(binary.LittleEndian.Uint16(pcm[2*i:])))
		if s == 0 {
			continue
		}
		cur := 1
		if s < 0 {
			cur = -1
		}
		if prev != 0 && cur != prev {
			n++
		}
		prev = cur
	}
	return n
}

// buildPackets encodes frames into a contiguous RTP sequence.
func buildPackets(t *testing.T, frames [][]byte) []*rtp.Packet {
	t.Helper()
	enc, err := audio.NewEncoder()
	if err != nil {
		t.Fatal(err)
	}
	pkts := make([]*rtp.Packet, 0, len(frames))
	for i, frame := range frames {
		payload, err := enc.Encode(frame)
		if err != nil {
			t.Fatal(err)
		}
		pkts = append(pkts, &rtp.Packet{
			Header: rtp.Header{
				Version:        2,
				PayloadType:    111,
				SequenceNumber: uint16(1000 + i),
				Timestamp:      uint32(90000 + i*audio.FrameSamples),
				SSRC:           42,
			},
			Payload: payload,
		})
	}
	return pkts
}

// scriptedRead hands out packets in order and then keeps returning final.
func scriptedRead(pkts []*rtp.Packet, final error) func() (*rtp.Packet, error) {
	i := 0
	return func() (*rtp.Packet, error) {
		if i < len(pkts) {
			p := pkts[i]
			i++
			return p, nil
		}
		return nil, final
	}
}

// collect drains every buffered frame from out.
func collect(out chan []byte) [][]byte {
	var frames [][]byte
	for {
		select {
		case f := <-out:
			frames = append(frames, f)
		default:
			return frames
		}
	}
}

// wantTones asserts frame pitches against a high/low pattern.
func wantTones(t *testing.T, frames [][]byte, high []bool) {
	t.Helper()
	if len(frames) != len(high) {
		t.Fatalf("got %d frames, want %d", len(frames), len(high))
	}
	for i, frame := range frames {
		if len(frame) != audio.FrameBytes {
			t.Fatalf("frame %d is %d bytes, want %d", i, len(frame), audio.FrameBytes)
		}
		c := crossings(frame)
		if high[i] && c < 45 {
			t.Errorf("frame %d has %d crossings, want high tone", i, c)
		}
		if !high[i] && c > 35 {
			t.Errorf("frame %d has %d crossings, want low tone", i, c)
		}
	}
}

func TestInboundDecodesInOrder(t *testing.T) {
	low, high := toneFrame(lowHz), toneFrame(highHz)
	pkts := buildPackets(t, [][]byte{low, high, low, high})
	dec, err := audio.NewDecoder()
	if err != nil {
		t.Fatal(err)
	}
	out := make(chan []byte, callerPCMBuffer)

	err = inbound(context.Background(), scriptedRead(pkts, io.EOF), audio.SampleRate, dec, out, discard)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("inbound returned %v, want io.EOF", err)
	}
	wantTones(t, collect(out), []bool{false, true, false, true})
}

func TestInboundReordersPackets(t *testing.T) {
	low, high := toneFrame(lowHz), toneFrame(highHz)
	pkts := buildPackets(t, [][]byte{low, high, low, high})
	swapped := []*rtp.Packet{pkts[0], pkts[2], pkts[1], pkts[3]}
	dec, err := audio.NewDecoder()
	if err != nil {
		t.Fatal(err)
	}
	out := make(chan []byte, callerPCMBuffer)

	err = inbound(context.Background(), scriptedRead(swapped, io.EOF), audio.SampleRate, dec, out, discard)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("inbound returned %v, want io.EOF", err)
	}
	wantTones(t, collect(out), []bool{false, true, false, true})
}

func TestInboundSurvivesCorruptPacket(t *testing.T) {
	low := toneFrame(lowHz)
	pkts := buildPackets(t, [][]byte{low, low, low, low})
	pkts[1].Payload = []byte{0xFF} // truncated code-3 TOC: libopus rejects it
	dec, err := audio.NewDecoder()
	if err != nil {
		t.Fatal(err)
	}
	out := make(chan []byte, callerPCMBuffer)

	err = inbound(context.Background(), scriptedRead(pkts, io.EOF), audio.SampleRate, dec, out, discard)
	if !errors.Is(err, io.EOF) {
		t.Fatalf("inbound returned %v, want io.EOF", err)
	}
	wantTones(t, collect(out), []bool{false, false, false})
}

func TestInboundPropagatesReadError(t *testing.T) {
	dec, err := audio.NewDecoder()
	if err != nil {
		t.Fatal(err)
	}
	boom := errors.New("boom")
	out := make(chan []byte, 1)

	if err := inbound(context.Background(), scriptedRead(nil, boom), audio.SampleRate, dec, out, discard); !errors.Is(err, boom) {
		t.Fatalf("inbound returned %v, want boom", err)
	}
}

func TestInboundExitsOnCancelWhenBlocked(t *testing.T) {
	low := toneFrame(lowHz)
	pkts := buildPackets(t, [][]byte{low, low, low})
	dec, err := audio.NewDecoder()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	read := scriptedRead(pkts, nil)
	blockingRead := func() (*rtp.Packet, error) {
		if pkt, err := read(); pkt != nil || err != nil {
			return pkt, err
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	out := make(chan []byte, 1) // fills after the first decoded frame

	done := make(chan error, 1)
	go func() { done <- inbound(ctx, blockingRead, audio.SampleRate, dec, out, discard) }()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("inbound did not exit after cancel")
	}
}
