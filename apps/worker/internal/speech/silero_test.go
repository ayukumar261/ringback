package speech

import (
	"encoding/binary"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/wav"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

func fixture(t testing.TB, name string) []byte {
	t.Helper()
	pcm, rate, err := wav.Read("testdata/" + name + ".wav")
	if err != nil {
		t.Fatal(err)
	}
	if rate != 16000 {
		t.Fatalf("rate %d", rate)
	}
	// Deterministic transport conversion only; the production causal resampler
	// still processes all 48 kHz input. Native delay is tested separately.
	out := make([]byte, len(pcm)*3)
	for i := 0; i < len(pcm); i += 2 {
		for j := range 3 {
			copy(out[i*3+j*2:], pcm[i:i+2])
		}
	}
	return out
}
func scalePCM(pcm []byte, gain float64) []byte {
	out := make([]byte, len(pcm))
	for i := 0; i+1 < len(pcm); i += 2 {
		v := int16(binary.LittleEndian.Uint16(pcm[i:]))
		binary.LittleEndian.PutUint16(out[i:], uint16(int16(float64(v)*gain)))
	}
	return out
}
func atFrame(pcm []byte, i int) []byte {
	if i < 0 || i >= len(pcm) {
		return nil
	}
	return pcm[i:min(i+audio.FrameBytes, len(pcm))]
}

type speechCase struct {
	name          string
	caller, agent []byte
	want          []Segment
}

func speechCases(t testing.TB) []speechCase {
	caller, agent := fixture(t, "caller"), fixture(t, "agent")
	want := []Segment{{3200 * time.Millisecond, 6800 * time.Millisecond}}
	cases := []speechCase{{name: "silence", caller: make([]byte, len(caller))}}
	for _, gain := range []float64{1, .1, .03} {
		cases = append(cases, speechCase{fmt.Sprintf("speech_%g", gain), scalePCM(caller, gain), nil, want})
	}
	// Second actual speaker, with utterance boundaries marked independently.
	cases = append(cases, speechCase{"second_speaker", scalePCM(agent, .2), nil, []Segment{{600 * time.Millisecond, 9360 * time.Millisecond}}})
	rng := rand.New(rand.NewPCG(19, 81))
	noise := make([]byte, len(caller))
	noisy := scalePCM(caller, .1)
	for i := 0; i < len(noise); i += 2 {
		v := rng.NormFloat64()*600 + 250*math.Sin(2*math.Pi*120*float64(i/2)/audio.SampleRate)
		binary.LittleEndian.PutUint16(noise[i:], uint16(int16(v)))
		c := int16(binary.LittleEndian.Uint16(noisy[i:]))
		binary.LittleEndian.PutUint16(noisy[i:], uint16(c+int16(v*.3)))
	}
	cases = append(cases, speechCase{"noise_only", noise, nil, nil}, speechCase{"speech_in_noise", noisy, nil, want})
	for _, gain := range []float64{.15, .4, .8} {
		for _, delay := range []int{0, 3, 9, 14} {
			echo := make([]byte, len(agent))
			copy(echo[delay*audio.FrameBytes:], scalePCM(agent, gain))
			cases = append(cases, speechCase{fmt.Sprintf("echo_%g_%dms", gain, delay*20), echo, agent, nil})
			if gain == .4 {
				for _, voiceGain := range []float64{.1, .03} {
					mixed := make([]byte, len(caller))
					for i := 0; i < len(mixed); i += audio.FrameBytes {
						copy(mixed[i:], audio.Mix(scalePCM(atFrame(caller, i), voiceGain), atFrame(echo, i)))
					}
					cases = append(cases, speechCase{fmt.Sprintf("overlap_%g_%dms", voiceGain, delay*20), mixed, agent, want})
				}
			}
		}
	}
	changing := make([]byte, len(agent))
	for i := 0; i < len(changing); i += audio.FrameBytes {
		delay, gain := 0, .4
		if i >= 250*audio.FrameBytes {
			delay, gain = 9, .15
		}
		copy(changing[i:], scalePCM(atFrame(agent, i-delay*audio.FrameBytes), gain))
	}
	cases = append(cases, speechCase{"echo_path_change", changing, agent, nil})
	early := make([]byte, len(caller))
	copy(early[40*audio.FrameBytes:], scalePCM(caller[160*audio.FrameBytes:], .1))
	earlyEcho := make([]byte, len(agent))
	copy(earlyEcho[3*audio.FrameBytes:], scalePCM(agent, .4))
	for i := 0; i < len(early); i += audio.FrameBytes {
		copy(early[i:], audio.Mix(atFrame(early, i), atFrame(earlyEcho, i)))
	}
	cases = append(cases, speechCase{"early_overlap", early, agent, []Segment{{800 * time.Millisecond, 4400 * time.Millisecond}}})
	cases = append(cases, speechCase{"overlap_without_echo", scalePCM(caller, .1), agent, want})
	cases = append(cases, speechCase{"speakerphone_echo", fixture(t, "speakerphone-mic"), fixture(t, "speakerphone-lpb"), nil})
	cases = append(cases, speechCase{"speakerphone_moving_echo", fixture(t, "speakerphone-moving-mic"), fixture(t, "speakerphone-moving-lpb"), nil})
	return cases
}

type measuredSpans struct{ missed, falseVoice, startError, endError time.Duration }

func measureSpans(got, want []Segment, total time.Duration) measuredSpans {
	inside := func(s []Segment, at time.Duration) bool {
		for _, v := range s {
			if v.Started <= at && at < v.Ended {
				return true
			}
		}
		return false
	}
	var m measuredSpans
	for at := time.Duration(0); at < total; at += time.Millisecond {
		actual, expected := inside(got, at), inside(want, at)
		if expected && !actual {
			m.missed += time.Millisecond
		}
		if actual && !expected {
			m.falseVoice += time.Millisecond
		}
	}
	if len(got) > 0 && len(want) > 0 {
		m.startError = (got[0].Started - want[0].Started).Abs()
		m.endError = (got[len(got)-1].Ended - want[len(want)-1].Ended).Abs()
	}
	return m
}
func detectCase(t testing.TB, c speechCase) []Segment {
	t.Helper()
	d := NewDetector(nil)
	if d.Err() != nil {
		t.Fatal(d.Err())
	}
	for i := 0; i < max(len(c.caller), len(c.agent)); i += audio.FrameBytes {
		d.Record(atFrame(c.caller, i), atFrame(c.agent, i))
	}
	d.Finish()
	if d.Err() != nil {
		t.Fatal(d.Err())
	}
	return d.Take()
}

func TestSileroSpeechFixtures(t *testing.T) {
	for _, c := range speechCases(t) {
		t.Run(c.name, func(t *testing.T) {
			got := detectCase(t, c)
			total := time.Duration((max(len(c.caller), len(c.agent))+audio.FrameBytes-1)/audio.FrameBytes) * audio.FrameDuration
			m := measureSpans(got, c.want, total)
			var duration time.Duration
			for _, s := range c.want {
				duration += s.Ended - s.Started
			}
			t.Logf("Silero missed=%v false=%v start_error=%v end_error=%v spans=%v", m.missed, m.falseVoice, m.startError, m.endError, got)
			if len(c.want) == 0 && len(got) != 0 {
				t.Errorf("non-speech produced caller segments")
			}
			missLimit := duration / 10
			if strings.Contains(c.name, "0.03") {
				missLimit = duration / 5
			}
			if len(c.want) > 0 && (len(got) == 0 || m.missed > missLimit || m.falseVoice > 250*time.Millisecond || m.startError > 150*time.Millisecond || m.endError > 250*time.Millisecond) {
				t.Errorf("speech exceeds fixture error limits")
			}
		})
	}
}

func TestSileroMissingRuntimeOmitsTimestamps(t *testing.T) {
	if os.Getenv("RINGBACK_TEST_MISSING_ORT") == "1" {
		d := NewDetector(nil)
		if d.Err() == nil {
			t.Fatal("loaded deliberately missing runtime")
		}
		d.Record(nil, nil)
		d.Finish()
		if len(d.Take()) != 0 {
			t.Fatal("invented timestamps after initialization failure")
		}
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestSileroMissingRuntimeOmitsTimestamps$")
	cmd.Env = append(os.Environ(), "RINGBACK_TEST_MISSING_ORT=1", "ONNXRUNTIME_SHARED_LIBRARY_PATH=/deliberately-missing/ringback-ort")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("initialization failure handling: %v\n%s", err, out)
	}
}
