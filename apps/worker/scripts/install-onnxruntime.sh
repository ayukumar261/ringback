#!/bin/sh
# Install the pinned CPU runtime; the Go binding supplies its own C headers.
set -eu
prefix=${1:?usage: install-onnxruntime.sh PREFIX}
version=1.30.0
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x64; sha=a5ed5a3cac51fbb2e90da632ae43d19212faaa20e76484e62bcb7c23ddb3b3fd ;;
  Linux-aarch64|Linux-arm64) platform=linux-aarch64; sha=e16a27a8ed330bbc698df7330b0cf56e722f354e3bcc92118682c74ef3c3e3da ;;
  Darwin-arm64) platform=osx-arm64; sha=6ebb5062a934537c352937821f9fe9718e7de1a2db1122a93dd363ffd53a7012 ;;
  *) echo "Unsupported ONNX Runtime platform" >&2; exit 1 ;;
esac
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
archive=onnxruntime-$platform-$version
curl --fail --location --retry 3 "https://github.com/microsoft/onnxruntime/releases/download/v$version/$archive.tgz" -o "$scratch/runtime.tgz"
if command -v sha256sum >/dev/null; then
  echo "$sha  $scratch/runtime.tgz" | sha256sum -c -
else
  echo "$sha  $scratch/runtime.tgz" | shasum -a 256 -c -
fi
tar -xzf "$scratch/runtime.tgz" -C "$scratch"
mkdir -p "$prefix/lib" "$prefix/share/onnxruntime"
cp -R "$scratch/$archive/lib/"* "$prefix/lib/"
cp "$scratch/$archive/LICENSE" "$scratch/$archive/ThirdPartyNotices.txt" "$prefix/share/onnxruntime/"
