# syntax=docker/dockerfile:1

# ONNX Runtime uses glibc. Build and run against the same Debian release.
FROM golang:1.26-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config libopus-dev libopusfile-dev curl ca-certificates \
    meson ninja-build libabsl-dev=20220623.1-1+deb12u2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/ scripts/
RUN scripts/install-speexdsp.sh /opt/speech && scripts/install-webrtc.sh /opt/speech \
    && scripts/install-onnxruntime.sh /opt/speech
ENV PKG_CONFIG_PATH=/opt/speech/lib/pkgconfig \
    LD_LIBRARY_PATH=/opt/speech/lib \
    ONNXRUNTIME_SHARED_LIBRARY_PATH=/opt/speech/lib/libonnxruntime.so
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build ./...
ARG GIT_SHA=dev
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w -X main.version=${GIT_SHA}" -o /out/worker .

FROM debian:bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
    libopus0 libopusfile0 ca-certificates wget libabsl20220623=20220623.1-1+deb12u2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /opt/speech/lib/ /opt/speech/lib/
COPY --from=builder /opt/speech/share/ /opt/speech/share/
COPY internal/speech/models/LICENSE /opt/speech/share/licenses/silero/LICENSE
ENV LD_LIBRARY_PATH=/opt/speech/lib \
    ONNXRUNTIME_SHARED_LIBRARY_PATH=/opt/speech/lib/libonnxruntime.so
COPY --from=builder /out/worker /usr/local/bin/worker
RUN mkdir -p /audio && chown nobody:nogroup /audio
USER nobody
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["worker"]
