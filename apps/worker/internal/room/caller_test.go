package room

import (
	"testing"

	"github.com/livekit/protocol/livekit"
)

func TestCaller(t *testing.T) {
	for _, tt := range []struct {
		name  string
		attrs map[string]string
		want  Caller
	}{
		{
			name: "inbound by absence",
			attrs: map[string]string{
				livekit.AttrSIPPhoneNumber: "+14155550100",
				livekit.AttrSIPTrunkNumber: "+17627013110",
			},
			want: Caller{From: "+14155550100", To: "+17627013110", Direction: DirectionInbound},
		},
		{
			name: "inbound declared",
			attrs: map[string]string{
				AttrDirection:              DirectionInbound,
				livekit.AttrSIPPhoneNumber: "+14155550100",
				livekit.AttrSIPTrunkNumber: "+17627013110",
			},
			want: Caller{From: "+14155550100", To: "+17627013110", Direction: DirectionInbound},
		},
		{
			name: "outbound swaps from and to",
			attrs: map[string]string{
				AttrDirection:              DirectionOutbound,
				livekit.AttrSIPPhoneNumber: "+14155550100",
				livekit.AttrSIPTrunkNumber: "+17627013110",
			},
			want: Caller{From: "+17627013110", To: "+14155550100", Direction: DirectionOutbound},
		},
		{
			name: "unknown value reads as inbound",
			attrs: map[string]string{
				AttrDirection:              "Outbound",
				livekit.AttrSIPPhoneNumber: "+14155550100",
				livekit.AttrSIPTrunkNumber: "+17627013110",
			},
			want: Caller{From: "+14155550100", To: "+17627013110", Direction: DirectionInbound},
		},
		{
			name:  "outbound with hidden numbers",
			attrs: map[string]string{AttrDirection: DirectionOutbound},
			want:  Caller{Direction: DirectionOutbound},
		},
		{
			name: "outbound carries the prompt verbatim",
			attrs: map[string]string{
				AttrDirection:              DirectionOutbound,
				AttrPrompt:                 "  Order a large pepperoni.\n",
				livekit.AttrSIPPhoneNumber: "+14155550100",
				livekit.AttrSIPTrunkNumber: "+17627013110",
			},
			want: Caller{From: "+17627013110", To: "+14155550100", Direction: DirectionOutbound, Prompt: "  Order a large pepperoni.\n"},
		},
		{
			name: "inbound has no prompt",
			attrs: map[string]string{
				AttrDirection:              DirectionInbound,
				livekit.AttrSIPPhoneNumber: "+14155550100",
				livekit.AttrSIPTrunkNumber: "+17627013110",
			},
			want: Caller{From: "+14155550100", To: "+17627013110", Direction: DirectionInbound},
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := caller(tt.attrs); got != tt.want {
				t.Fatalf("caller() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestRememberCallerPreservesProviderAttribution(t *testing.T) {
	var captured []Caller
	r := &Room{onSIP: func(c Caller) { captured = append(captured, c) }}
	attrs := map[string]string{
		livekit.AttrSIPCallID: "livekit-call", "sip.twilio.callSid": "CA-provider-call", AttrDirection: DirectionOutbound,
	}
	r.rememberCaller(attrs)
	r.rememberCaller(attrs)
	if len(captured) != 1 || captured[0].TwilioCallSID != "CA-provider-call" {
		t.Fatalf("captured attribution = %+v", captured)
	}
	// The snapshot survives participant removal.
	if r.lastCaller.TwilioCallSID != "CA-provider-call" {
		t.Fatalf("retained caller = %+v", r.lastCaller)
	}
	r.rememberCaller(map[string]string{livekit.AttrSIPCallID: "other-call"})
	if len(captured) != 1 {
		t.Fatal("published a SIP identity without a Twilio reference")
	}
}
