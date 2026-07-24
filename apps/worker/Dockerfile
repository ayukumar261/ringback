# syntax=docker/dockerfile:1

# Begin a builder stage from base image
FROM golang:1.25 AS builder

# Set working directory
WORKDIR /src

# Copy module manifests; the glob tolerates the not-yet-existing go.sum
COPY go.* ./

# Download module dependencies
RUN go mod download

# Copy remaining source
COPY . .

# Receive the git SHA to stamp into the binary
ARG GIT_SHA=dev

# Build a static binary with the version stamped in
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${GIT_SHA}" -o /out/worker .

# Begin a runner stage from base image
FROM alpine:3.22 AS runner

# Copy the compiled binary from the builder stage
COPY --from=builder /out/worker /usr/local/bin/worker

# Drop root privileges
USER nobody

# Probe the health endpoint with busybox wget
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://127.0.0.1:8080/healthz || exit 1

# Launch the worker binary
ENTRYPOINT ["worker"]
