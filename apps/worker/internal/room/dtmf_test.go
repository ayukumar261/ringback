package room

import (
	"context"
	"errors"
	"testing"

	"github.com/livekit/protocol/livekit"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

// recordDTMF returns a publish closure that appends every event to got.
func recordDTMF(got *[]*livekit.SipDTMF) func(*livekit.SipDTMF) error {
	return func(ev *livekit.SipDTMF) error {
		*got = append(*got, ev)
		return nil
	}
}

func TestSendDTMFPublishesEachDigit(t *testing.T) {
	for _, tt := range []struct {
		name   string
		digits string
		codes  []uint32
	}{
		{name: "menu keys", digits: "1234*#", codes: []uint32{1, 2, 3, 4, 10, 11}},
		{name: "full alphabet", digits: "0123456789*#", codes: []uint32{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var got []*livekit.SipDTMF
			if err := sendDTMF(tt.digits, recordDTMF(&got), nil); err != nil {
				t.Fatalf("err = %v, want nil", err)
			}
			if len(got) != len(tt.codes) {
				t.Fatalf("published %d events, want %d", len(got), len(tt.codes))
			}
			for i, ev := range got {
				wantDigit := string(tt.digits[i])
				if ev.Code != tt.codes[i] || ev.Digit != wantDigit {
					t.Fatalf("event %d = {Code: %d, Digit: %q}, want {Code: %d, Digit: %q}", i, ev.Code, ev.Digit, tt.codes[i], wantDigit)
				}
			}
		})
	}
}

func TestSendDTMFRejectsBeforePublishing(t *testing.T) {
	for _, tt := range []struct {
		name   string
		digits string
	}{
		{name: "letter", digits: "12a"},
		{name: "space", digits: "1 2"},
		{name: "pause", digits: "1w2"},
		{name: "empty", digits: ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var got []*livekit.SipDTMF
			err := sendDTMF(tt.digits, recordDTMF(&got), nil)
			if err == nil {
				t.Fatalf("err = nil, want error for %q", tt.digits)
			}
			if len(got) != 0 {
				t.Fatalf("published %d events, want 0", len(got))
			}
		})
	}
}

func TestSendDTMFStopsAtPublishError(t *testing.T) {
	boom := errors.New("boom")
	calls := 0
	err := sendDTMF("123", func(*livekit.SipDTMF) error {
		calls++
		if calls == 2 {
			return boom
		}
		return nil
	}, nil)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
	if calls != 2 {
		t.Fatalf("publish called %d times, want 2", calls)
	}
}

func TestSendDTMFPressesTapPerPublishedDigit(t *testing.T) {
	rec, _ := newTestTap(t, discard)
	defer rec.close()
	var got []*livekit.SipDTMF
	if err := sendDTMF("12", recordDTMF(&got), rec); err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
	if want := 2 * 2 * audio.DTMFSamples; len(rec.tone) != want {
		t.Errorf("tap holds %d tone bytes, want %d for two key presses", len(rec.tone), want)
	}
}

func TestSendDTMFPressesTapOnlyForPublishedDigits(t *testing.T) {
	rec, _ := newTestTap(t, discard)
	defer rec.close()
	boom := errors.New("boom")
	calls := 0
	err := sendDTMF("123", func(*livekit.SipDTMF) error {
		calls++
		if calls == 2 {
			return boom
		}
		return nil
	}, rec)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want boom", err)
	}
	if want := 2 * audio.DTMFSamples; len(rec.tone) != want {
		t.Errorf("tap holds %d tone bytes, want %d for the one digit that went out", len(rec.tone), want)
	}
}

func TestSendDTMFClosedRoom(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &Room{ctx: ctx, log: discard}
	if err := r.SendDTMF("1"); err == nil {
		t.Fatal("err = nil, want error on a closed room")
	}
}
