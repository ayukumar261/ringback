#!/usr/bin/env bash

# Exit on error, unset variable, or failed pipe
set -euo pipefail

# Switch to deployment directory
cd /opt/ringback

# LiveKit CLI needs $HOME set
export HOME="${HOME:-/root}"

# The SIP setup we want, found on the live server by the names inside these files
INBOUND_TRUNK_JSON=deploy/sip/inbound-trunk.json
OUTBOUND_TRUNK_JSON=deploy/sip/outbound-trunk.json
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

# Wait for the LiveKit API because deploys briefly max out the one-core box while containers restart
sip_wait() {
  local i err
  for i in {1..30}; do
    err=$(lk --silent sip inbound list --json 2>&1 >/dev/null) && return
    [[ $i -eq 30 ]] && { echo "[sip] LiveKit API not answering at $LIVEKIT_URL: $err" >&2; return 1; }
    sleep 2
  done
}

# Print the ID of the inbound or outbound trunk whose name matches the JSON file, if any
sip_find_trunk() {
  lk --silent sip "$1" list --json | jq -r --arg n "$(jq -r .trunk.name "$2")" \
    '.items // [] | map(select(.name == $n)) | .[0].sipTrunkId // empty'
}

# Print every trunk ID in the given direction, one per line
sip_list_trunks() {
  lk --silent sip "$1" list --json | jq -r '.items // [] | .[].sipTrunkId'
}

# Create or update one trunk to match its JSON, keeping its ID stable, and print that ID
sip_converge_trunk() {
  local dir=$1 json=$2 trunk_id ids
  trunk_id=$(sip_find_trunk "$dir" "$json")
  # After a rename nothing matches the new name, so adopt the one leftover trunk instead of creating a twin
  if [[ -z "$trunk_id" ]]; then
    ids=$(sip_list_trunks "$dir")
    if [[ -n "$ids" && $(echo "$ids" | wc -l) -gt 1 ]]; then
      echo "[sip] several $dir trunks exist and none matches $(jq -r .trunk.name "$json"); delete the strays, then redeploy" >&2
      return 1
    fi
    trunk_id=$ids
    if [[ -n "$trunk_id" ]]; then
      echo "[sip] adopting lone $dir trunk $trunk_id under its new name" >&2
    fi
  fi
  if [[ -z "$trunk_id" ]]; then
    lk --silent sip "$dir" create "$json" >/dev/null
    trunk_id=$(sip_find_trunk "$dir" "$json")
    echo "[sip] created $dir trunk $trunk_id" >&2
  else
    # lk update parses the Info object (ID embedded), not the request wrapper its usage string claims
    jq --arg id "$trunk_id" '.trunk + {sip_trunk_id: $id}' "$json" \
      | lk --silent sip "$dir" update - >/dev/null
    echo "[sip] updated $dir trunk $trunk_id" >&2
  fi
  echo "$trunk_id"
}

# Converge the live LiveKit SIP config with deploy/sip/
sip_converge() {
  sip_env
  sip_wait

  # Converge both trunks, keeping only the inbound ID for the rule below
  local trunk_id
  trunk_id=$(sip_converge_trunk inbound "$INBOUND_TRUNK_JSON")
  sip_converge_trunk outbound "$OUTBOUND_TRUNK_JSON" >/dev/null

  # The rule converges the same way, always pinned to the inbound trunk found above rather than an ID baked into the file
  local rule_name rule_id rule_ids
  rule_name=$(jq -r .name "$RULE_JSON")
  rule_id=$(lk --silent sip dispatch list --json | jq -r --arg n "$rule_name" \
    '.items // [] | map(select(.name == $n)) | .[0].sipDispatchRuleId // empty')
  # Renamed rules get the same lone-adoption treatment as the trunks
  if [[ -z "$rule_id" ]]; then
    rule_ids=$(lk --silent sip dispatch list --json | jq -r '.items // [] | .[].sipDispatchRuleId')
    if [[ -n "$rule_ids" && $(echo "$rule_ids" | wc -l) -gt 1 ]]; then
      echo "[sip] several dispatch rules exist and none is named $rule_name; delete the strays, then redeploy" >&2
      return 1
    fi
    rule_id=$rule_ids
    if [[ -n "$rule_id" ]]; then
      echo "[sip] adopting lone dispatch rule $rule_id under its new name" >&2
    fi
  fi
  if [[ -z "$rule_id" ]]; then
    jq --arg tid "$trunk_id" '.trunk_ids = [$tid]' "$RULE_JSON" \
      | lk --silent sip dispatch create - >/dev/null
    echo "[sip] created rule '$rule_name'"
  else
    jq --arg id "$rule_id" --arg tid "$trunk_id" \
      '{sip_dispatch_rule_id: $id, name: .name, trunk_ids: [$tid], rule: .rule, attributes: .attributes}' "$RULE_JSON" \
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
