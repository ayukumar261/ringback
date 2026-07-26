#!/usr/bin/env bash

# Exit on error, unset variable, or failed pipe
set -euo pipefail

# Switch to deployment directory
cd /opt/ringback

# Print a UTC-timestamped "started" line
echo "[deploy] $(date -u +%FT%TZ) started"

# Mirror origin/main exactly; immune to force-pushed history
git fetch origin && git reset --hard origin/main || echo "[deploy] git sync failed (continuing)"

# Download the latest image tags
docker compose pull

# Recreate any containers that changed
docker compose up -d

# Converge the live LiveKit SIP config with deploy/sip/
./deploy/sip/apply.sh

# Delete any untagged images to reclaim disk space
docker image prune -f

# Print a UTC-timestamped "finished" line
echo "[deploy] $(date -u +%FT%TZ) finished"
