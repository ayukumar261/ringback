package room

import (
	"fmt"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

// dtmfCodes maps each key to its RFC 4733 telephone event code.
var dtmfCodes = map[rune]uint32{
	'0': 0, '1': 1, '2': 2, '3': 3, '4': 4,
	'5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
	'*': 10, '#': 11,
}

// SendDTMF presses digits toward the far end, one telephone event per key.
func (r *Room) SendDTMF(digits string) error {
	if r.ctx.Err() != nil {
		return fmt.Errorf("room: send dtmf: room closed")
	}
	return sendDTMF(digits, func(ev *livekit.SipDTMF) error {
		return r.room.LocalParticipant.PublishDataPacket(ev, lksdk.WithDataPublishReliable(true))
	})
}

// sendDTMF validates every digit before publishing any of them.
func sendDTMF(digits string, publish func(*livekit.SipDTMF) error) error {
	if digits == "" {
		return fmt.Errorf("room: send dtmf: no digits")
	}
	events := make([]*livekit.SipDTMF, 0, len(digits))
	for _, d := range digits {
		code, ok := dtmfCodes[d]
		if !ok {
			return fmt.Errorf("room: send dtmf: invalid digit %q", d)
		}
		events = append(events, &livekit.SipDTMF{Code: code, Digit: string(d)})
	}
	for _, ev := range events {
		if err := publish(ev); err != nil {
			return fmt.Errorf("room: send dtmf %q: %w", ev.Digit, err)
		}
	}
	return nil
}
