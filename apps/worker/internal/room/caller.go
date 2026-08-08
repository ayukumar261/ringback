package room

import "github.com/livekit/protocol/livekit"

// The call's direction, declared once where it enters the system; the worker only reads it.
const (
	// AttrDirection is the participant attribute set by the dispatch rule (inbound) or the outbound placer.
	AttrDirection = "ringback.direction"
	// DirectionInbound marks a call someone placed to us.
	DirectionInbound = "inbound"
	// DirectionOutbound marks a call we placed.
	DirectionOutbound = "outbound"
)

// Caller reports the call's from and to numbers and its direction, all empty until a SIP participant is visible.
func (r *Room) Caller() (from, to, direction string) {
	for _, rp := range r.room.GetRemoteParticipants() {
		if attrs := rp.Attributes(); attrs[livekit.AttrSIPCallID] != "" {
			return caller(attrs)
		}
	}
	return "", "", ""
}

// caller maps one SIP participant's attributes to from/to/direction; anything but an explicit outbound reads as inbound.
func caller(attrs map[string]string) (from, to, direction string) {
	if attrs[AttrDirection] == DirectionOutbound {
		return attrs[livekit.AttrSIPTrunkNumber], attrs[livekit.AttrSIPPhoneNumber], DirectionOutbound
	}
	return attrs[livekit.AttrSIPPhoneNumber], attrs[livekit.AttrSIPTrunkNumber], DirectionInbound
}
