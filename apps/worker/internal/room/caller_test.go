package room

import (
	"testing"

	"github.com/livekit/protocol/livekit"
)

func TestCaller(t *testing.T) {
	for _, tt := range []struct {
		name  string
		attrs map[string]string
		from  string
		to    string
		dir   string
	}{
		{
			name: "inbound by absence",
			attrs: map[string]string{
				livekit.AttrSIPPhoneNumber: "+14155550100",
				livekit.AttrSIPTrunkNumber: "+17627013110",
			},
			from: "+14155550100", to: "+17627013110", dir: DirectionInbound,
		},
		{
			name: "inbound declared",
			attrs: map[string]string{
				AttrDirection:              DirectionInbound,
				livekit.AttrSIPPhoneNumber: "+14155550100",
				livekit.AttrSIPTrunkNumber: "+17627013110",
			},
			from: "+14155550100", to: "+17627013110", dir: DirectionInbound,
		},
		{
			name: "outbound swaps from and to",
			attrs: map[string]string{
				AttrDirection:              DirectionOutbound,
				livekit.AttrSIPPhoneNumber: "+14155550100",
				livekit.AttrSIPTrunkNumber: "+17627013110",
			},
			from: "+17627013110", to: "+14155550100", dir: DirectionOutbound,
		},
		{
			name: "unknown value reads as inbound",
			attrs: map[string]string{
				AttrDirection:              "Outbound",
				livekit.AttrSIPPhoneNumber: "+14155550100",
				livekit.AttrSIPTrunkNumber: "+17627013110",
			},
			from: "+14155550100", to: "+17627013110", dir: DirectionInbound,
		},
		{
			name:  "outbound with hidden numbers",
			attrs: map[string]string{AttrDirection: DirectionOutbound},
			from:  "", to: "", dir: DirectionOutbound,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			from, to, dir := caller(tt.attrs)
			if from != tt.from || to != tt.to || dir != tt.dir {
				t.Fatalf("caller() = (%q, %q, %q), want (%q, %q, %q)", from, to, dir, tt.from, tt.to, tt.dir)
			}
		})
	}
}
