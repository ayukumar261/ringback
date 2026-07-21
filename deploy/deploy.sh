#!/usr/bin/env bash

# Exit on error, unset variable, or failed pipe
set -euo pipefail

# Switch to deployment directory
cd /opt/ringback

# Print a UTC-timestamped "started" line
echo "[deploy] $(date -u +%FT%TZ) started"

# Retrieve compose and configuration updates
git pull --ff-only || echo "[deploy] git pull skipped/failed (continuing)"

# Download the latest image tags
docker compose pull

# Recreate any containers that changed
docker compose up -d

# Delete any untagged images to reclaim disk space
docker image prune -f

# Print a UTC-timestamped "finished" line
echo "[deploy] $(date -u +%FT%TZ) finished"
