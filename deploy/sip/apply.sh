#!/usr/bin/env bash

# Converge the live LiveKit SIP config with deploy/sip/*.json; run by deploy.sh on every deploy.
# DRY_RUN=1 prints the mutating requests instead of sending them.

set -euo pipefail

# Run from the repo root so file paths and .env resolve
cd "$(dirname "$0")/../.."

# Fall back to the deployment .env when creds aren't already in the environment
if [[ -z "${LIVEKIT_API_KEY:-}" && -f .env ]]; then
  set -a; source .env; set +a
fi
: "${LIVEKIT_API_KEY:?not set and no .env found}"
: "${LIVEKIT_API_SECRET:?not set and no .env found}"
export LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
export LIVEKIT_API_KEY LIVEKIT_API_SECRET

TRUNK_JSON=deploy/sip/inbound-trunk.json
RULE_JSON=deploy/sip/dispatch-rule.json

# Names are the identity anchor for convergence
TRUNK_NAME=$(jq -r .trunk.name "$TRUNK_JSON")
RULE_NAME=$(jq -r .name "$RULE_JSON")

# Pipe a request body from stdin into lk, or print it under DRY_RUN
send() { # send <label> <lk subcommand...>
  local label=$1; shift
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    echo "[sip] DRY_RUN, would $label:"; sed 's/^/  /'
  else
    lk --silent "$@" - >/dev/null
    echo "[sip] $label: ok"
  fi
}

find_trunk() {
  lk --silent sip inbound list --json | jq -r --arg n "$TRUNK_NAME" \
    '.items // [] | map(select(.name == $n)) | .[0].sipTrunkId // empty'
}

# Wait for the LiveKit API on fresh boots
for i in {1..10}; do
  lk sip inbound list --json >/dev/null 2>&1 && break
  [[ $i -eq 10 ]] && { echo "[sip] LiveKit API unreachable at $LIVEKIT_URL" >&2; exit 1; }
  sleep 2
done

# Trunk: create if missing, otherwise replace in place (ID preserved, no routing gap)
trunk_id=$(find_trunk)
if [[ -z "$trunk_id" ]]; then
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    echo "[sip] DRY_RUN, would create trunk '$TRUNK_NAME'"
    trunk_id="ST_<created>"
  else
    lk --silent sip inbound create "$TRUNK_JSON" >/dev/null
    trunk_id=$(find_trunk)
    echo "[sip] created trunk '$TRUNK_NAME' ($trunk_id)"
  fi
else
  # lk update parses the Info object (ID embedded), not the request wrapper its usage string claims
  jq --arg id "$trunk_id" '.trunk + {sip_trunk_id: $id}' "$TRUNK_JSON" \
    | send "update trunk $trunk_id" sip inbound update
fi

# Rule: same, always pinned to the discovered trunk ID rather than the one in the file
rule_id=$(lk --silent sip dispatch list --json | jq -r --arg n "$RULE_NAME" \
  '.items // [] | map(select(.name == $n)) | .[0].sipDispatchRuleId // empty')
if [[ -z "$rule_id" ]]; then
  jq --arg tid "$trunk_id" '.trunk_ids = [$tid]' "$RULE_JSON" \
    | send "create rule '$RULE_NAME'" sip dispatch create
else
  jq --arg id "$rule_id" --arg tid "$trunk_id" \
    '{sip_dispatch_rule_id: $id, name: .name, trunk_ids: [$tid], rule: .rule}' "$RULE_JSON" \
    | send "update rule $rule_id" sip dispatch update
fi
