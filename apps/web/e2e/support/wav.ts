// A silent mono 16-bit PCM WAV, so the browser reports an exact duration.
const sampleRate = 8000
const bytesPerSample = 2
const headerLength = 44

export function silentWav(seconds: number) {
  const dataLength = sampleRate * bytesPerSample * seconds
  const wav = Buffer.alloc(headerLength + dataLength)
  wav.write("RIFF", 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16) // fmt chunk size
  wav.writeUInt16LE(1, 20) // PCM
  wav.writeUInt16LE(1, 22) // mono
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28) // byte rate
  wav.writeUInt16LE(bytesPerSample, 32) // block align
  wav.writeUInt16LE(bytesPerSample * 8, 34) // bits per sample
  wav.write("data", 36)
  wav.writeUInt32LE(dataLength, 40)
  return wav
}
