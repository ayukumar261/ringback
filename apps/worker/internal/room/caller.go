package room

import "github.com/livekit/protocol/livekit"

// The call's direction, declared once where it enters the system; the worker only reads it.
const (
	// AttrDirection is the participant attribute set by the dispatch rule (inbound) or the outbound placer.
	AttrDirection = "ringback.direction"
	// AttrPrompt is the participant attribute carrying the prompt the outbound placer sent, absent on inbound.
	AttrPrompt = "ringback.prompt"
	// DirectionInbound marks a call someone placed to us.
	DirectionInbound = "inbound"
	// DirectionOutbound marks a call we placed.
	DirectionOutbound = "outbound"
)

// Caller is what the SIP participant says about the call.
type Caller struct {
	From          string // caller's number, empty if hidden
	To            string // dialed number, empty likewise
	Direction     string // DirectionInbound or DirectionOutbound
	Prompt        string // the placer's prompt, verbatim, empty on inbound
	TwilioCallSID string // Twilio's ID for the SIP leg, which prices it
}

// Caller reports the call's numbers, direction, and prompt, all empty until a SIP participant is visible.
func (r *Room) Caller() Caller {
	for _, rp := range r.room.GetRemoteParticipants() {
		if attrs := rp.Attributes(); attrs[livekit.AttrSIPCallID] != "" {
			return caller(attrs)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lastCaller
}

// caller maps one SIP participant's attributes to a Caller; anything but an explicit outbound reads as inbound.
func caller(attrs map[string]string) Caller {
	c := Caller{Prompt: attrs[AttrPrompt], TwilioCallSID: attrs["sip.twilio.callSid"]}
	if attrs[AttrDirection] == DirectionOutbound {
		c.From, c.To, c.Direction = attrs[livekit.AttrSIPTrunkNumber], attrs[livekit.AttrSIPPhoneNumber], DirectionOutbound
		return c
	}
	c.From, c.To, c.Direction = attrs[livekit.AttrSIPPhoneNumber], attrs[livekit.AttrSIPTrunkNumber], DirectionInbound
	return c
}

// rememberCaller preserves attribution after the participant has left, including unanswered calls.
func (r *Room) rememberCaller(attrs map[string]string) {
	if attrs[livekit.AttrSIPCallID] == "" && attrs["sip.twilio.callSid"] == "" {
		return
	}
	c := caller(attrs)
	r.mu.Lock()
	previous := r.lastCaller
	r.lastCaller = c
	r.mu.Unlock()
	if r.onSIP != nil && c.TwilioCallSID != "" && c != previous {
		r.onSIP(c)
	}
}
