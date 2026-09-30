#!/bin/sh
# Build the same echo canceller/resampler on CI and in the worker image.
set -eu
prefix=${1:?usage: install-speexdsp.sh PREFIX}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
curl --fail --location --retry 3 https://downloads.xiph.org/releases/speex/speexdsp-1.2.1.tar.gz -o "$scratch/speex.tar.gz"
echo "8c777343e4a6399569c72abc38a95b24db56882c83dbdb6c6424a5f4aeb54d3d  $scratch/speex.tar.gz" | sha256sum -c -
tar -xzf "$scratch/speex.tar.gz" -C "$scratch"
cd "$scratch/speexdsp-1.2.1"
./configure --prefix="$prefix" --disable-examples --disable-static
make -j2
make install
mkdir -p "$prefix/share/licenses/speexdsp"
cp COPYING "$prefix/share/licenses/speexdsp/"
