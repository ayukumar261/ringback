# syntax=docker/dockerfile:1

# Build on the matching alpine variant so cgo links against musl like the runner
FROM golang:1.26-alpine3.22 AS builder

# Install the C toolchain plus the opus headers the cgo binding needs
RUN apk add --no-cache build-base pkgconf opus-dev opusfile-dev

# Set working directory
WORKDIR /src

# Copy module manifests; the glob tolerates the not-yet-existing go.sum
COPY go.* ./

# Download module dependencies
RUN go mod download

# Copy remaining source
COPY . .

# Compile every package so leaf packages stay buildable before main imports them
RUN CGO_ENABLED=1 go build ./...

# Receive the git SHA to stamp into the binary
ARG GIT_SHA=dev

# Build the worker binary with the version stamped in
RUN CGO_ENABLED=1 go build -trimpath -ldflags="-s -w -X main.version=${GIT_SHA}" -o /out/worker .

# Begin a runner stage from base image
FROM alpine:3.22 AS runner

# Install the shared libraries the cgo binary loads at runtime
RUN apk add --no-cache opus opusfile

# Copy the compiled binary from the builder stage
COPY --from=builder /out/worker /usr/local/bin/worker

# Drop root privileges
USER nobody

# Probe the health endpoint with busybox wget
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://127.0.0.1:8080/healthz || exit 1

# Launch the worker binary
ENTRYPOINT ["worker"]
