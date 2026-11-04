#!/usr/bin/env bash

# Restrict SIP signaling (5060 udp+tcp) to Twilio's signaling ranges; drops everyone else in-kernel.
# Idempotent; run by ringback-firewall.service at boot and by deploy.sh on every deploy.

set -euo pipefail

CHAIN=SIP-GUARD

# Twilio's Elastic SIP Trunking signaling ranges, the only peers in the calls we place
TWILIO_RANGES=(
  54.172.60.0/30
  54.244.51.0/30
  54.171.127.192/30
  35.156.191.128/30
  54.65.63.192/30
  54.169.127.128/30
  54.252.254.64/30
  177.71.206.192/30
)

iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
for cidr in "${TWILIO_RANGES[@]}"; do
  iptables -A "$CHAIN" -s "$cidr" -j ACCEPT
done
iptables -A "$CHAIN" -j DROP

# Route 5060 through the chain, once per protocol
for proto in udp tcp; do
  iptables -C INPUT -p "$proto" --dport 5060 -j "$CHAIN" 2>/dev/null \
    || iptables -I INPUT -p "$proto" --dport 5060 -j "$CHAIN"
done

echo "[fw] 5060 restricted to $(iptables -S "$CHAIN" | grep -c ' -j ACCEPT') Twilio ranges"
