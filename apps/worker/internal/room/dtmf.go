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
	}, r.tap)
}

// sendDTMF validates every digit before publishing any of them and hands each published digit to the recording.
func sendDTMF(digits string, publish func(*livekit.SipDTMF) error, rec *tap) error {
	if digits == "" {
		return fmt.Errorf("room: send dtmf: no digits")
	}
	for _, d := range digits {
		if _, ok := dtmfCodes[d]; !ok {
			return fmt.Errorf("room: send dtmf: invalid digit %q", d)
		}
	}
	for _, d := range digits {
		ev := &livekit.SipDTMF{Code: dtmfCodes[d], Digit: string(d)}
		if err := publish(ev); err != nil {
			return fmt.Errorf("room: send dtmf %q: %w", ev.Digit, err)
		}
		rec.press(d)
	}
	return nil
}
