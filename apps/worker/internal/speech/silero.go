package speech

import (
	_ "embed"
	"fmt"
	"math"
	"os"
	"sync"
	"time"

	ort "github.com/yalue/onnxruntime_go"
)

// Silero v6.2.3, commit 5cd7945676eb32225748052e2e6a0580e4686a08.
//
//go:embed models/silero_vad.onnx
var sileroModel []byte

var initializeVAD = sync.OnceValue(func() error {
	if path := os.Getenv("ONNXRUNTIME_SHARED_LIBRARY_PATH"); path != "" {
		ort.SetSharedLibraryPath(path)
	}
	return ort.InitializeEnvironment()
})

const vadSamples = 512 // Silero consumes 32 ms at 16 kHz plus 64 samples of context.

type sileroVoice struct {
	echo                                 *echoFilter
	session                              *ort.AdvancedSession
	input, state, probability, nextState *ort.Tensor[float32]
	rate                                 *ort.Tensor[int64]
	buffer                               []float32
	processed, recorded                  int64
	closed, drained                      bool
}

func newSileroVoice() (result VoiceDetector, err error) {
	if err = initializeVAD(); err != nil {
		return nil, fmt.Errorf("speech: ONNX Runtime: %w", err)
	}
	v := &sileroVoice{buffer: make([]float32, 0, vadSamples+detectionFrame)}
	defer func() {
		if err != nil {
			v.Close()
		}
	}()
	if v.echo, err = newEchoFilter(); err != nil {
		return nil, err
	}
	if v.input, err = ort.NewEmptyTensor[float32](ort.NewShape(1, 576)); err != nil {
		return nil, err
	}
	if v.state, err = ort.NewEmptyTensor[float32](ort.NewShape(2, 1, 128)); err != nil {
		return nil, err
	}
	if v.probability, err = ort.NewEmptyTensor[float32](ort.NewShape(1, 1)); err != nil {
		return nil, err
	}
	if v.nextState, err = ort.NewEmptyTensor[float32](ort.NewShape(2, 1, 128)); err != nil {
		return nil, err
	}
	if v.rate, err = ort.NewTensor(ort.NewShape(1), []int64{detectionRate}); err != nil {
		return nil, err
	}
	opts, err := ort.NewSessionOptions()
	if err != nil {
		return nil, err
	}
	defer opts.Destroy()
	if err = opts.SetIntraOpNumThreads(1); err != nil {
		return nil, err
	}
	if err = opts.SetInterOpNumThreads(1); err != nil {
		return nil, err
	}
	v.session, err = ort.NewAdvancedSessionWithONNXData(sileroModel,
		[]string{"input", "state", "sr"}, []string{"output", "stateN"},
		[]ort.Value{v.input, v.state, v.rate}, []ort.Value{v.probability, v.nextState}, opts)
	if err != nil {
		return nil, fmt.Errorf("speech: load Silero: %w", err)
	}
	return v, nil
}

func (v *sileroVoice) Process(caller, agent []byte) ([]VoiceFrame, error) {
	if v.closed || v.drained {
		return nil, fmt.Errorf("speech: detector finished")
	}
	v.recorded += detectionFrame
	return v.process(caller, agent)
}

func (v *sileroVoice) process(caller, agent []byte) ([]VoiceFrame, error) {
	pcm, err := v.echo.Process(caller, agent)
	if err != nil {
		return nil, err
	}
	v.buffer = append(v.buffer, pcm...)
	var frames []VoiceFrame
	for len(v.buffer) >= vadSamples {
		input := v.input.GetData()
		copy(input[64:], v.buffer[:vadSamples])
		if err := v.session.Run(); err != nil {
			return nil, fmt.Errorf("speech: inference: %w", err)
		}
		p := v.probability.GetData()[0]
		if math.IsNaN(float64(p)) || p < 0 || p > 1 {
			return nil, fmt.Errorf("speech: invalid probability %v", p)
		}
		copy(v.state.GetData(), v.nextState.GetData())
		copy(input[:64], input[len(input)-64:])
		start := max(0, v.processed-v.echo.delay)
		v.processed += vadSamples
		end := min(v.recorded, max(0, v.processed-v.echo.delay))
		if end > start {
			frames = append(frames, VoiceFrame{Started: sampleTime(start), Ended: sampleTime(end), Probability: float64(p)})
		}
		copy(v.buffer, v.buffer[vadSamples:])
		v.buffer = v.buffer[:len(v.buffer)-vadSamples]
	}
	return frames, nil
}

func sampleTime(samples int64) time.Duration {
	return time.Duration(samples) * time.Second / detectionRate
}

// Flush drains DSP and the final partial inference block only at end of input.
// These zeros are never counted as recorded samples or exposed as timestamps.
func (v *sileroVoice) Flush() ([]VoiceFrame, error) {
	if v.closed {
		return nil, fmt.Errorf("speech: detector closed")
	}
	if v.drained || v.recorded == 0 {
		return nil, nil
	}
	v.drained = true
	var frames []VoiceFrame
	for range 4 {
		if v.processed-v.echo.delay >= v.recorded {
			return frames, nil
		}
		next, err := v.process(nil, nil)
		if err != nil {
			return nil, err
		}
		frames = append(frames, next...)
	}
	return nil, fmt.Errorf("speech: final inference did not drain")
}

func (v *sileroVoice) Close() {
	if v.closed {
		return
	}
	v.closed = true
	if v.session != nil {
		v.session.Destroy()
	}
	if v.input != nil {
		v.input.Destroy()
	}
	if v.state != nil {
		v.state.Destroy()
	}
	if v.probability != nil {
		v.probability.Destroy()
	}
	if v.nextState != nil {
		v.nextState.Destroy()
	}
	if v.rate != nil {
		v.rate.Destroy()
	}
	if v.echo != nil {
		v.echo.Close()
	}
}
