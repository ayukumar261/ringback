#!/bin/sh
# AEC3 from the standalone WebRTC Audio Processing release (BSD).
set -eu
prefix=${1:?usage: install-webrtc.sh PREFIX}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
curl --fail --location --retry 3 https://freedesktop.org/software/pulseaudio/webrtc-audio-processing/webrtc-audio-processing-1.3.tar.xz -o "$scratch/apm.tar.xz"
if command -v sha256sum >/dev/null; then
  echo "2365e93e778d7b61b5d6e02d21c47d97222e9c7deff9e1d0838ad6ec2e86f1b9  $scratch/apm.tar.xz" | sha256sum -c -
else
  echo "2365e93e778d7b61b5d6e02d21c47d97222e9c7deff9e1d0838ad6ec2e86f1b9  $scratch/apm.tar.xz" | shasum -a 256 -c -
fi
tar -xf "$scratch/apm.tar.xz" -C "$scratch"
# WebRTC 1.3 uses uint32_t here without including its header. GCC 15 no longer
# supplies it through <memory>, so include it explicitly before compiling.
task_queue_header="$scratch/webrtc-audio-processing-1.3/webrtc/api/task_queue/task_queue_base.h"
sed '/#include <memory>/i\
#include <cstdint>
' "$task_queue_header" > "$scratch/task_queue_base.h"
mv "$scratch/task_queue_base.h" "$task_queue_header"
meson setup "$scratch/build" "$scratch/webrtc-audio-processing-1.3" --prefix="$prefix" --libdir=lib -Dbuildtype=release
meson compile -C "$scratch/build" -j2
meson install -C "$scratch/build"
mkdir -p "$prefix/share/licenses/webrtc"
cp "$scratch/webrtc-audio-processing-1.3/COPYING" "$prefix/share/licenses/webrtc/"
