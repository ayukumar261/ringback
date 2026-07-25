package room

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/livekit/server-sdk-go/v2/pkg/samplebuilder"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

// maxLatePackets is the reorder window the samplebuilder tolerates.
const maxLatePackets = 32

// readLoop pumps caller RTP into the pcm channel until the track or room ends.
func (r *Room) readLoop(track *webrtc.TrackRemote) {
	defer r.wg.Done()
	read := func() (*rtp.Packet, error) {
		pkt, _, err := track.ReadRTP()
		return pkt, err
	}
	err := inbound(r.ctx, read, track.Codec().ClockRate, r.dec, r.callerPCM, r.log)
	if r.ctx.Err() != nil {
		return
	}
	r.terminate(fmt.Errorf("room: caller track: %w", err))
}

// inbound turns caller RTP into ordered PCM on out until read fails or ctx ends.
func inbound(ctx context.Context, read func() (*rtp.Packet, error), clockRate uint32, dec *audio.Decoder, out chan<- []byte, log *slog.Logger) error {
	sb := samplebuilder.New(maxLatePackets, &codecs.OpusPacket{}, clockRate)
	for {
		pkt, err := read()
		if err != nil {
			return err
		}
		sb.Push(pkt)
		for {
			sample := sb.Pop()
			if sample == nil {
				break
			}
			pcm, err := dec.Decode(sample.Data)
			if err != nil {
				log.Warn("dropping undecodable caller packet", "err", err)
				continue
			}
			select {
			case out <- pcm:
			case <-ctx.Done():
				return nil
			}
		}
	}
}
