package speech

import (
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"time"

	"github.com/ayukumar261/ringback/apps/worker/internal/audio"
)

const (
	analysisQueue = 50 // at most one second of audio, approximately 192 KB
	analysisWait  = 250 * time.Millisecond
)

// cgo releases a Go scheduler slot while native DSP is still using a CPU.
// Cap native work across calls so bursty model initialization/inference cannot
// create one runnable native thread per call and exhaust a container CPU quota.
var speechWorkers = make(chan struct{}, max(1, min(4, runtime.GOMAXPROCS(0)-1)))

func (a *Analyzer) work(fn func()) bool {
	select {
	case speechWorkers <- struct{}{}:
	case <-a.failed:
		return false
	}
	defer func() { <-speechWorkers }()
	fn()
	return true
}

type analysisCommand struct {
	caller, agent [audio.FrameBytes]byte
	cutoff        time.Duration
	reply         chan []Segment
	finish        bool
}

// Analyzer runs native DSP on one goroutine per recording. Enqueueing
// audio never waits for inference. Overload or failure disables timestamps for
// this recording, rather than silently skipping audio and shifting the clock.
type Analyzer struct {
	mu           sync.Mutex
	commands     chan analysisCommand
	failed, done chan struct{}
	failOnce     sync.Once
	log          *slog.Logger
	recorded     time.Duration
	closing      bool
	remaining    []Segment
}

func NewAnalyzer(log *slog.Logger) *Analyzer {
	return newAnalyzer(log, func() *Detector { return NewDetector(nil) })
}

func newAnalyzer(log *slog.Logger, factory func() *Detector) *Analyzer {
	if log == nil {
		log = slog.Default()
	}
	a := &Analyzer{commands: make(chan analysisCommand, analysisQueue), failed: make(chan struct{}), done: make(chan struct{}), log: log}
	go a.run(factory)
	return a
}

func (a *Analyzer) fail(err error) {
	a.failOnce.Do(func() {
		close(a.failed)
		a.log.Warn("caller speech timestamps disabled", "err", err)
	})
}

func (a *Analyzer) enqueue(c analysisCommand) {
	select {
	case <-a.failed:
		return
	default:
	}
	select {
	case a.commands <- c:
	default:
		a.fail(fmt.Errorf("speech: analysis queue full"))
	}
}

func (a *Analyzer) Record(caller, agent []byte) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closing {
		return
	}
	a.recorded += audio.FrameDuration
	var c analysisCommand
	copy(c.caller[:], caller)
	copy(c.agent[:], agent)
	a.enqueue(c)
}

// Take captures a cutoff before waiting. Callers must not hold the recording
// mutex while waiting: the resampler and model may need another real frame.
func (a *Analyzer) Take() []Segment {
	a.mu.Lock()
	closing := a.closing
	var reply chan []Segment
	if !closing {
		reply = make(chan []Segment, 1)
		a.enqueue(analysisCommand{cutoff: a.recorded, reply: reply})
	}
	a.mu.Unlock()
	timer := time.NewTimer(analysisWait)
	defer timer.Stop()
	if closing {
		select {
		case <-a.done:
			a.mu.Lock()
			defer a.mu.Unlock()
			select {
			case <-a.failed:
				return nil
			default:
			}
			result := a.remaining
			a.remaining = nil
			return result
		case <-a.failed:
			return nil
		case <-timer.C:
			a.fail(fmt.Errorf("speech: final inference timeout"))
			return nil
		}
	}
	select {
	case result := <-reply:
		select {
		case <-a.failed:
			return nil
		default:
			return result
		}
	case <-a.failed:
		return nil
	case <-timer.C:
		a.fail(fmt.Errorf("speech: transcript inference timeout"))
		return nil
	}
}

// Stop queues a final drain without waiting; safe on the recording goroutine.
func (a *Analyzer) Stop() {
	a.mu.Lock()
	if !a.closing {
		a.closing = true
		a.enqueue(analysisCommand{finish: true})
	}
	a.mu.Unlock()
}

func (a *Analyzer) Close() {
	a.Stop()
	timer := time.NewTimer(analysisWait)
	defer timer.Stop()
	select {
	case <-a.done:
	case <-a.failed:
	case <-timer.C:
		a.fail(fmt.Errorf("speech: shutdown timeout"))
	}
}

func (a *Analyzer) run(factory func() *Detector) {
	defer close(a.done)
	var d *Detector
	if !a.work(func() { d = factory() }) {
		return
	}
	defer func() {
		if d.voice != nil && !d.finished {
			d.voice.Close()
		}
	}()
	if d.Err() != nil {
		a.fail(d.Err())
		return
	}
	var pending []analysisCommand
	for {
		select {
		case <-a.failed:
			return
		default:
		}
		select {
		case <-a.failed:
			return
		case c := <-a.commands:
			switch {
			case c.finish:
				if !a.work(d.Finish) {
					return
				}
			case c.reply != nil:
				pending = append(pending, c)
			default:
				if !a.work(func() { d.Record(c.caller[:], c.agent[:]) }) {
					return
				}
			}
			if d.Err() != nil {
				a.fail(d.Err())
				return
			}
			// Requests are ordered with audio, so each transcript claims only its own
			// prefix, even when a later inference block crosses several cutoffs.
			for len(pending) > 0 && pending[0].cutoff <= d.frontier {
				p := pending[0]
				pending = pending[1:]
				p.reply <- d.takeAt(p.cutoff)
			}
			if len(pending) > analysisQueue {
				a.fail(fmt.Errorf("speech: transcript queue full"))
				return
			}
			if c.finish {
				a.mu.Lock()
				a.remaining = d.Take()
				a.mu.Unlock()
				return
			}
		}
	}
}
