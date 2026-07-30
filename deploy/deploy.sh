#!/usr/bin/env bash

# Exit on error, unset variable, or failed pipe
set -euo pipefail

# Switch to deployment directory
cd /opt/ringback

# LiveKit CLI needs $HOME set
export HOME="${HOME:-/root}"

# Desired-state SIP data; the names inside are the identity anchor for convergence
TRUNK_JSON=deploy/sip/inbound-trunk.json
RULE_JSON=deploy/sip/dispatch-rule.json

# Fall back to the deployment .env when LiveKit creds aren't already in the environment
sip_env() {
  if [[ -z "${LIVEKIT_API_KEY:-}" && -f .env ]]; then
    set -a; source .env; set +a
  fi
  : "${LIVEKIT_API_KEY:?not set and no .env found}"
  : "${LIVEKIT_API_SECRET:?not set and no .env found}"
  export LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
  export LIVEKIT_API_KEY LIVEKIT_API_SECRET
}

# Wait for the LiveKit API; deploys briefly peg the 1-vCPU box while containers recreate
sip_wait() {
  local i err
  for i in {1..30}; do
    err=$(lk --silent sip inbound list --json 2>&1 >/dev/null) && return
    [[ $i -eq 30 ]] && { echo "[sip] LiveKit API not answering at $LIVEKIT_URL: $err" >&2; return 1; }
    sleep 2
  done
}

# Print the ID of the trunk matching the desired name, if it exists
sip_find_trunk() {
  lk --silent sip inbound list --json | jq -r --arg n "$(jq -r .trunk.name "$TRUNK_JSON")" \
    '.items // [] | map(select(.name == $n)) | .[0].sipTrunkId // empty'
}

# Converge the live LiveKit SIP config with deploy/sip/
sip_converge() {
  sip_env
  sip_wait

  # Trunk: create if missing, otherwise replace in place (ID preserved, no routing gap)
  local trunk_id
  trunk_id=$(sip_find_trunk)
  if [[ -z "$trunk_id" ]]; then
    lk --silent sip inbound create "$TRUNK_JSON" >/dev/null
    trunk_id=$(sip_find_trunk)
    echo "[sip] created trunk $trunk_id"
  else
    # lk update parses the Info object (ID embedded), not the request wrapper its usage string claims
    jq --arg id "$trunk_id" '.trunk + {sip_trunk_id: $id}' "$TRUNK_JSON" \
      | lk --silent sip inbound update - >/dev/null
    echo "[sip] updated trunk $trunk_id"
  fi

  # Rule: same, always pinned to the discovered trunk ID rather than one baked into the file
  local rule_name rule_id
  rule_name=$(jq -r .name "$RULE_JSON")
  rule_id=$(lk --silent sip dispatch list --json | jq -r --arg n "$rule_name" \
    '.items // [] | map(select(.name == $n)) | .[0].sipDispatchRuleId // empty')
  if [[ -z "$rule_id" ]]; then
    jq --arg tid "$trunk_id" '.trunk_ids = [$tid]' "$RULE_JSON" \
      | lk --silent sip dispatch create - >/dev/null
    echo "[sip] created rule '$rule_name'"
  else
    jq --arg id "$rule_id" --arg tid "$trunk_id" \
      '{sip_dispatch_rule_id: $id, name: .name, trunk_ids: [$tid], rule: .rule}' "$RULE_JSON" \
      | lk --silent sip dispatch update - >/dev/null
    echo "[sip] updated rule $rule_id"
  fi
}

# Print a UTC-timestamped "started" line
echo "[deploy] $(date -u +%FT%TZ) started"

# Mirror origin/main exactly, then re-exec the freshly synced script so this
# run uses the new deploy logic
if [[ "${1:-}" != "--synced" ]]; then
  git fetch origin && git reset --hard origin/main || echo "[deploy] git sync failed (continuing)"
  exec ./deploy/deploy.sh --synced
fi

# Download the latest image tags
docker compose pull

# Recreate any containers that changed
docker compose up -d

# Converge the live LiveKit SIP config with the desired-state data
sip_converge

# Keep the SIP firewall in lockstep with the trunk's allowed ranges
./deploy/host/firewall.sh

# Converge the host Caddy config with deploy/host/
if ! command -v caddy >/dev/null; then
  echo "[caddy] caddy binary not found, skipping convergence" >&2
elif caddy validate --config deploy/host/Caddyfile --adapter caddyfile; then
  cmp -s deploy/host/Caddyfile /etc/caddy/Caddyfile \
    || install -m 644 deploy/host/Caddyfile /etc/caddy/Caddyfile
  systemctl reload caddy
  echo "[caddy] config validated and reloaded"
else
  echo "[caddy] invalid Caddyfile, keeping current config" >&2
fi

# Delete any untagged images to reclaim disk space
docker image prune -f

# Print a UTC-timestamped "finished" line
echo "[deploy] $(date -u +%FT%TZ) finished"
