package audio

import "time"

const (
	// SampleRate is the only sample rate the bridge speaks.
	SampleRate = 48000
	// Channels is the only channel layout the bridge speaks.
	Channels = 1
	// FrameDuration is the playout cadence of one frame.
	FrameDuration = 20 * time.Millisecond
	// FrameSamples is the sample count of one 20 ms frame.
	FrameSamples = 960
	// FrameBytes is the byte count of one 20 ms frame of 16-bit PCM.
	FrameBytes = FrameSamples * 2
)

const (
	maxPacketBytes   = 4000 // encode output ceiling libopus recommends
	maxDecodeSamples = 5760 // longest legal packet, 120 ms at 48 kHz
)
