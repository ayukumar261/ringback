package room

import (
	"context"
	"fmt"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

// paceLoop feeds the published agent track one encoded frame every 20 ms.
func (r *Room) paceLoop() {
	defer r.wg.Done()
	ticker := time.NewTicker(audio.FrameDuration)
	defer ticker.Stop()
	write := func(packet []byte) error {
		return r.track.WriteSample(media.Sample{Data: packet, Duration: audio.FrameDuration}, &lksdk.SampleWriteOptions{})
	}
	if err := pace(r.ctx, ticker.C, r.buf, r.enc, write); err != nil {
		r.terminate(fmt.Errorf("room: agent track: %w", err))
	}
}

// pace encodes and writes one playout frame per tick until ctx ends or a write fails.
func pace(ctx context.Context, tick <-chan time.Time, buf *audio.PlayoutBuffer, enc *audio.Encoder, write func([]byte) error) error {
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-tick:
			packet, err := enc.Encode(buf.ReadFrame())
			if err != nil {
				return err
			}
			if err := write(packet); err != nil {
				return err
			}
		}
	}
}
