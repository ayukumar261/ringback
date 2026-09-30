package speech

/*
#cgo pkg-config: speexdsp webrtc-audio-processing-1
#cgo CXXFLAGS: -std=c++17 -Wno-deprecated-declarations
#include <speex/speex_resampler.h>
#include "echo_native.h"
#include <math.h>
#include <stdlib.h>
// Fit a direct echo path from waveform correlation, not relative loudness.
// Three near-perfect fits establish a simple linear path. Once established,
// subtraction preserves quieter independent speech during double talk.
// AEC3 remains active for general acoustic paths and runs on the original mic.
typedef struct { int lag, count, trusted; double gain; } DirectEcho;
static int remove_correlated_echo(DirectEcho *state, short *out, const short *history) {
  double energy = 1;
  for (int i = 0; i < 320; i++) energy += (double)out[i]*out[i];
  int best = 0; double score = 0;
  for (int lag = 0; lag <= 5120; lag += 8) {
    double dot = 0, ref = 1;
    for (int i = 0; i < 320; i += 4) {
      double x = history[5120-lag+i]; dot += out[i]*x; ref += x*x;
    }
    double fit = dot*dot/ref;
    if (fit > score) { score = fit; best = lag; }
  }
  int coarse = best; score = 0; double gain = 0;
  for (int lag = coarse > 8 ? coarse-8 : 0; lag <= coarse+8 && lag <= 5120; lag++) {
    double dot = 0, ref = 1;
    for (int i = 0; i < 320; i++) {
      double x = history[5120-lag+i]; dot += out[i]*x; ref += x*x;
    }
    double fit = dot*dot/ref;
    if (fit > score) { score = fit; best = lag; gain = dot/ref; }
  }
  double coherence = score/energy;
  if (coherence > 0.995 && energy > 320*100) {
    if (abs(best-state->lag) <= 1 && fabs(gain-state->gain) < 0.05*fmax(fabs(gain),0.01)) state->count++;
    else { state->count = 1; state->trusted = 0; }
    state->lag = best; state->gain = gain;
    if (state->count >= 3) state->trusted = 1;
  } else {
    state->count = 0;
    // A strong newly correlated path invalidates a learned direct path.
    if (coherence > 0.98 && (abs(best-state->lag)>1 || fabs(gain-state->gain)>0.2*fmax(fabs(state->gain),0.01))) state->trusted=0;
  }
  if (state->trusted) { best=state->lag; gain=state->gain; }
  else if (coherence < 0.5) return 0;
  for (int i = 0; i < 320; i++) {
    double x = out[i] - gain*history[5120-best+i];
    out[i] = (short)fmax(-32768, fmin(32767, x));
  }
  return state->trusted;
}
*/
import "C"

import (
	"encoding/binary"
	"fmt"
	"unsafe"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

const detectionRate = 16000
const detectionFrame = detectionRate / 50
const echoProcessingDelay = 128 + 96 // AEC3 framing/overlap and noise suppression

// echoFilter operates on copies, leaving the WAV and the audio sent to ASR intact.
// Both channels use the same causal Speex resampler. WebRTC AEC3 cancels
// delayed playback and suppresses residual echo; only the detector sees this
// processed signal. The WAV and ASR channels retain the original samples.
type echoFilter struct {
	resampler             *C.SpeexResamplerState
	echo                  unsafe.Pointer
	input                 [audio.FrameSamples * 2]C.spx_int16_t
	down                  [detectionFrame * 2]C.spx_int16_t
	caller, agent, output [detectionFrame]C.spx_int16_t
	history               [5120 + detectionFrame]C.spx_int16_t
	direct                C.DirectEcho
	projected             [detectionFrame]C.spx_int16_t
	aligned               [echoProcessingDelay + detectionFrame]C.spx_int16_t
	delay                 int64 // 16 kHz samples: resampler + 128 AEC3 + 96 noise suppression
}

func newEchoFilter() (*echoFilter, error) {
	f := &echoFilter{}
	var code C.int
	f.resampler = C.speex_resampler_init(2, audio.SampleRate, detectionRate, 5, &code)

	f.echo = C.ringback_echo_new()
	if code != 0 || f.resampler == nil || f.echo == nil {
		f.Close()
		return nil, fmt.Errorf("speech: initialize resampler/AEC: %d", code)
	}
	f.delay = int64(C.speex_resampler_get_output_latency(f.resampler)) + echoProcessingDelay
	return f, nil
}

func (f *echoFilter) Process(caller, agent []byte) ([]float32, error) {
	clear(f.input[:])
	for channel, pcm := range [][]byte{caller, agent} {
		for i := 0; i+1 < min(len(pcm), audio.FrameBytes); i += 2 {
			f.input[i+channel] = C.spx_int16_t(int16(binary.LittleEndian.Uint16(pcm[i:])))
		}
	}
	in, out := C.spx_uint32_t(audio.FrameSamples), C.spx_uint32_t(detectionFrame)
	code := C.speex_resampler_process_interleaved_int(f.resampler, &f.input[0], &in, &f.down[0], &out)
	if code != 0 || in != audio.FrameSamples || out != detectionFrame {
		return nil, fmt.Errorf("speech: resample: code=%d input=%d output=%d", code, in, out)
	}
	for i := range detectionFrame {
		f.caller[i], f.agent[i] = f.down[2*i], f.down[2*i+1]
	}

	copy(f.history[:], f.history[detectionFrame:])
	copy(f.history[len(f.history)-detectionFrame:], f.agent[:])
	copy(f.projected[:], f.caller[:])
	trusted := C.remove_correlated_echo(&f.direct, &f.projected[0], &f.history[0]) != 0
	copy(f.aligned[:echoProcessingDelay], f.aligned[detectionFrame:])
	copy(f.aligned[echoProcessingDelay:], f.projected[:])
	if code := C.ringback_echo_process(f.echo, &f.caller[0], &f.agent[0], &f.output[0]); code != 0 {
		return nil, fmt.Errorf("speech: echo processing: %d", code)
	}
	if trusted {
		copy(f.output[:], f.aligned[:detectionFrame])
	}
	result := make([]float32, detectionFrame)
	for i, sample := range f.output {
		result[i] = float32(sample) / 32768
	}
	return result, nil
}

func (f *echoFilter) Close() {
	if f.echo != nil {
		C.ringback_echo_free(f.echo)
		f.echo = nil
	}
	if f.resampler != nil {
		C.speex_resampler_destroy(f.resampler)
		f.resampler = nil
	}
}
