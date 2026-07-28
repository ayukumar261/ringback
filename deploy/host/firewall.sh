#!/usr/bin/env bash

# Restrict SIP signaling (5060 udp+tcp) to the trunk's allowed_addresses; drops everyone else in-kernel.
# Idempotent; run by ringback-firewall.service at boot and by deploy.sh on every deploy.

set -euo pipefail

# Run from the repo root so the trunk JSON resolves
cd "$(dirname "$0")/../.."

CHAIN=SIP-GUARD

ranges=$(jq -r '.trunk.allowed_addresses[]?' deploy/sip/inbound-trunk.json)
[[ -n "$ranges" ]] || { echo "[fw] no allowed_addresses in trunk JSON; refusing to lock out SIP" >&2; exit 1; }

iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
while read -r cidr; do
  iptables -A "$CHAIN" -s "$cidr" -j ACCEPT
done <<< "$ranges"
iptables -A "$CHAIN" -j DROP

# Route 5060 through the chain, once per protocol
for proto in udp tcp; do
  iptables -C INPUT -p "$proto" --dport 5060 -j "$CHAIN" 2>/dev/null \
    || iptables -I INPUT -p "$proto" --dport 5060 -j "$CHAIN"
done

echo "[fw] 5060 restricted to $(iptables -S "$CHAIN" | grep -c ' -j ACCEPT') Twilio ranges"
