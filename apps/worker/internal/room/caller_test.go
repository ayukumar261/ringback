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
