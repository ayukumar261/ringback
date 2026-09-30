#include "echo_native.h"
#include <modules/audio_processing/include/audio_processing.h>
#include <new>

struct EchoProcessor {
  rtc::scoped_refptr<webrtc::AudioProcessing> apm;
};

extern "C" void *ringback_echo_new(void) {
  auto *echo = new (std::nothrow) EchoProcessor;
  if (!echo) return nullptr;
  echo->apm = webrtc::AudioProcessingBuilder().Create();
  if (!echo->apm) {
    delete echo;
    return nullptr;
  }
  webrtc::AudioProcessing::Config config;
  config.echo_canceller.enabled = true;
  config.noise_suppression.enabled = true;
  echo->apm->ApplyConfig(config);
  return echo;
}

extern "C" int ringback_echo_process(void *ptr, const int16_t *caller,
                                     const int16_t *agent, int16_t *output) {
  auto *echo = static_cast<EchoProcessor *>(ptr);
  webrtc::StreamConfig stream(16000, 1);
  int16_t scratch[160];
  for (int i = 0; i < 320; i += 160) {
    int err = echo->apm->ProcessReverseStream(agent + i, stream, stream, scratch);
    if (err) return err;
    // AEC3 estimates the acoustic/network delay.
    echo->apm->set_stream_delay_ms(0);
    err = echo->apm->ProcessStream(caller + i, stream, stream, output + i);
    if (err) return err;
  }
  return 0;
}

extern "C" void ringback_echo_free(void *ptr) {
  delete static_cast<EchoProcessor *>(ptr);
}
