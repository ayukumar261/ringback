# Silero model

`silero_vad.onnx` is the unmodified model from Silero VAD v6.2.3,
commit `5cd7945676eb32225748052e2e6a0580e4686a08`:

https://github.com/snakers4/silero-vad/blob/5cd7945676eb32225748052e2e6a0580e4686a08/src/silero_vad/data/silero_vad.onnx

SHA-256: `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`.
The adjacent `LICENSE` is the upstream MIT license. The model is embedded in the
worker binary; calls never download model weights.
