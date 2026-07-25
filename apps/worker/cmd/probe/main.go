package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/elevenlabs"
)

const (
	inputFormat  = "pcm_48000"
	quietWindow  = 4 * time.Second
	noReplyLimit = 15 * time.Second
	callDeadline = 2 * time.Minute
)

// main runs the probe and exits nonzero on failure.
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "probe:", err)
		os.Exit(1)
	}
}

// run streams the input wav to the agent and records everything that comes back.
func run() error {
	in := flag.String("in", "", "input wav to stream as the caller")
	out := flag.String("out", "out.wav", "output wav for agent speech")
	flag.Parse()
	if *in == "" {
		return fmt.Errorf("-in is required")
	}
	apiKey := os.Getenv("ELEVENLABS_API_KEY")
	agentID := os.Getenv("ELEVENLABS_AGENT_ID")
	if apiKey == "" || agentID == "" {
		return fmt.Errorf("set ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID")
	}

	pcm, rate, err := readWAV(*in)
	if err != nil {
		return err
	}
	sendRate, err := formatRate(inputFormat)
	if err != nil {
		return err
	}
	if rate != sendRate {
		return fmt.Errorf("%s is %d Hz and the probe sends %s", *in, rate, inputFormat)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, callDeadline)
	defer cancel()

	client := &elevenlabs.Client{APIKey: apiKey, AgentID: agentID}
	start := time.Now()
	conv, err := client.Start(ctx, elevenlabs.StartOpts{})
	if err != nil {
		return err
	}
	defer conv.Close()
	meta := conv.Meta()
	outRate, err := formatRate(meta.AgentOutputAudioFormat)
	if err != nil {
		return err
	}
	fmt.Printf("connected in %s conversation=%s in=%s out=%s\n",
		time.Since(start).Round(time.Millisecond), meta.ConversationID, meta.UserInputAudioFormat, meta.AgentOutputAudioFormat)

	var agentPCM []byte
	var lastAudio atomic.Int64
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ev := range conv.Events() {
			ts := time.Since(start).Round(time.Millisecond)
			switch e := ev.(type) {
			case elevenlabs.AudioEvent:
				agentPCM = append(agentPCM, e.PCM...)
				lastAudio.Store(time.Now().UnixMilli())
				fmt.Printf("[%8s] audio %d bytes id=%d\n", ts, len(e.PCM), e.EventID)
			case elevenlabs.UserTranscript:
				fmt.Printf("[%8s] caller transcript %q\n", ts, e.Text)
			case elevenlabs.AgentResponse:
				fmt.Printf("[%8s] agent response %q\n", ts, e.Text)
			case elevenlabs.AgentResponseCorrection:
				fmt.Printf("[%8s] agent cut off after %q\n", ts, e.Corrected)
			case elevenlabs.Interruption:
				fmt.Printf("[%8s] interruption id=%d\n", ts, e.EventID)
			case elevenlabs.ClientError:
				fmt.Printf("[%8s] server error %s %s\n", ts, e.ErrorName, e.Message)
			case elevenlabs.UnknownEvent:
				raw := e.Raw
				if len(raw) > 200 {
					raw = raw[:200]
				}
				fmt.Printf("[%8s] unhandled %s %s\n", ts, e.Type, raw)
			}
		}
	}()

	chunk := sendRate / 10 * 2
	silence := make([]byte, chunk)
	fmt.Printf("streaming %.1fs of caller audio in 100ms chunks\n", float64(len(pcm))/float64(sendRate*2))
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	var sendErr error
	var inputDone time.Time
	off := 0
	for {
		<-ticker.C
		b := silence
		if off < len(pcm) {
			end := min(off+chunk, len(pcm))
			b = pcm[off:end]
			off = end
		} else if inputDone.IsZero() {
			inputDone = time.Now()
			fmt.Printf("[%8s] input finished, streaming silence\n", time.Since(start).Round(time.Millisecond))
		}
		if err := conv.SendAudio(b); err != nil {
			sendErr = err
			break
		}
		if inputDone.IsZero() {
			continue
		}
		last := time.UnixMilli(lastAudio.Load())
		if last.After(inputDone) && time.Since(last) > quietWindow {
			fmt.Printf("[%8s] agent went quiet, hanging up\n", time.Since(start).Round(time.Millisecond))
			break
		}
		if !last.After(inputDone) && time.Since(inputDone) > noReplyLimit {
			fmt.Printf("[%8s] no reply after input, hanging up\n", time.Since(start).Round(time.Millisecond))
			break
		}
	}

	conv.Close()
	<-done

	if len(agentPCM) > 0 {
		if err := writeWAV(*out, agentPCM, outRate); err != nil {
			return err
		}
		fmt.Printf("wrote %.1fs of agent speech to %s\n", float64(len(agentPCM))/float64(outRate*2), *out)
	} else {
		fmt.Println("no agent audio received")
	}
	if err := conv.Err(); err != nil {
		return fmt.Errorf("conversation ended with %w", err)
	}
	if sendErr != nil {
		return fmt.Errorf("send failed with %w", sendErr)
	}
	return nil
}

// readWAV loads a mono 16 bit PCM wav and returns its samples and rate.
func readWAV(path string) ([]byte, int, error) {
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

// writeWAV saves mono 16 bit PCM samples as a wav file.
func writeWAV(path string, pcm []byte, rate int) error {
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

// formatRate converts a pcm format name like pcm_48000 into its sample rate.
func formatRate(format string) (int, error) {
	s, ok := strings.CutPrefix(format, "pcm_")
	if !ok {
		return 0, fmt.Errorf("unsupported audio format %s", format)
	}
	return strconv.Atoi(s)
}
