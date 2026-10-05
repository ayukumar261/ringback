# Speech test recordings

Source: [Microsoft AEC Challenge](https://github.com/microsoft/AEC-Challenge),
commit `6c633d0a9d2a143a0e364899b91b06f127315b18`.
These are actual spoken recordings, not synthesized voices or tones.

| Local file | Upstream path |
| --- | --- |
| caller.wav | datasets/synthetic/nearend_speech/nearend_speech_fileid_25.wav |
| agent.wav | datasets/synthetic/farend_speech/farend_speech_fileid_25.wav |
| speakerphone-mic.wav | datasets/real/-0AcvGNEdEK-DQGxWmtq2Q_farend_singletalk_mic.wav |
| speakerphone-lpb.wav | datasets/real/-0AcvGNEdEK-DQGxWmtq2Q_farend_singletalk_lpb.wav |
| speakerphone-moving-mic.wav | datasets/real/-0AcvGNEdEK-DQGxWmtq2Q_farend_singletalk_with_movement_mic.wav |
| speakerphone-moving-lpb.wav | datasets/real/-0AcvGNEdEK-DQGxWmtq2Q_farend_singletalk_with_movement_lpb.wav |

Files are retained unmodified. Fetch bytes from
`https://media.githubusercontent.com/media/microsoft/AEC-Challenge/<commit>/<path>`.
The source repository uses Git LFS; raw.githubusercontent.com serves pointers.

## Attribution and terms

Microsoft's [dataset terms](https://github.com/microsoft/AEC-Challenge/blob/6c633d0a9d2a143a0e364899b91b06f127315b18/README.md#dataset-licenses)
apply; its MIT **code** license should not be interpreted as a blanket audio license.
The two clean speech sources are LibriVox readers `reader_08177` (clean_fileid_2370)
and `reader_05997` (clean_fileid_3693), identified in synthetic/meta.csv row 25.
The upstream terms identify LibriVox speech as public domain. The real microphone
and loopback pairs comes from the public real-device evaluation dataset; retain
this provenance when redistributing these fixtures.

Reference: Sridhar et al., *ICASSP 2021 Acoustic Echo Cancellation Challenge:
Datasets, Testing Framework, and Results*. The repository links the later
ICASSP 2022/2023 dataset descriptions as well.

## Annotations and generated cases

The caller source has one utterance from **3.20 to 6.80 seconds**, surrounded by
literal zero padding. The second speaker's utterance is **0.60 to 9.36 seconds**;
its trailing breath/room tail makes that edge less certain (roughly ±40 ms).
These are utterance boundaries marked from the clean reference waveforms,
including short internal pauses, rather than phoneme-level speech labels.
Both real-device pairs are labeled far-end single talk upstream: **no caller speech**.
The microphone and loopback lengths differ by 10 ms (stationary) or 20 ms (moving); the shorter channel is
zero padded on the original recording timeline, never stretched or realigned.

`silero_test.go` reproducibly varies caller gain (1, 0.1, 0.03), echo gain
(0.15, 0.4, 0.8), and echo delay (0, 60, 180, 280 ms). It also tests a sudden echo-path change, an early
interruption, overlap without echo, seeded Gaussian noise plus mains hum, speech
in that background, and digital silence. Mixed cases use actual recorded voices
with simulated linear echo; the speakerphone pairs test actual acoustic paths, including movement.
The noise is generated, not a recorded noise corpus. None of these fixtures alone
establishes accuracy for every accent, microphone, codec, or acoustic environment.

The test reports missed and false duration on a 1 ms evaluation grid, plus first
start and final end error. This grid measures intervals; it does not imply 1 ms
recognition accuracy. Tests require start error ≤150 ms, end error ≤250 ms,
false speech ≤250 ms, and missed speech ≤10% (≤20% at gain 0.03). Silence,
noise, and echo-only cases must produce no caller segments.

## SHA-256

- `agent.wav`: `4d41e93dddb2565fb6fe7cd8381c87204a8fe87195c4232d15bf86b7bf5c2864`
- `caller.wav`: `0b438a4846783542e947552db8a74f1b3037faced082dba913fc0e856391305d`
- `speakerphone-lpb.wav`: `9b204ad5473726526d14830103e53647897699ef89d49624964b7f2449040426`
- `speakerphone-mic.wav`: `6b4c3e01b969c5cad91f248ff967cfa03df6554f3a060d6e5b06b7d20341bba6`
- `speakerphone-moving-lpb.wav`: `36351723f158f5f266935ff3d12d2552db69c92d52582e7ef2ce60fcfefa729d`
- `speakerphone-moving-mic.wav`: `e42a648ff783349e9d14da7080d7a3657946d56d8bc34d1a2a3915fbb0a18943`
