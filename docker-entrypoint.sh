#!/bin/sh
# murdock container entrypoint.
#
# Brings up a userspace Cloudflare WARP tunnel so YouTube-bound grabs egress
# from a non-blocked IP, then starts the server. Everything here is best-effort:
# if any step fails (e.g. Render blocks the WARP UDP), MURDOCK_YT_PROXY is left
# unset and murdock runs exactly as it would without WARP — YouTube stays
# blocked, every other source works.

set -u

PROXY_ADDR="127.0.0.1:40000"
WARP_CONF="/tmp/warp.conf"

setup_warp() {
  cd /tmp || return 1

  # Register a free WARP device and generate a WireGuard profile (no account).
  wgcf register --accept-tos --config /tmp/wgcf-account.toml >/dev/null 2>&1 || return 1
  wgcf generate --config /tmp/wgcf-account.toml --profile "$WARP_CONF" >/dev/null 2>&1 || return 1

  # wireproxy reads the standard WireGuard profile plus this extra section.
  printf '\n[Socks5]\nBindAddress = %s\n' "$PROXY_ADDR" >> "$WARP_CONF"

  wireproxy -c "$WARP_CONF" >/tmp/wireproxy.log 2>&1 &
  sleep 4

  # Only trust the tunnel if traffic actually leaves through WARP. Cloudflare's
  # trace endpoint reports warp=on when the request egressed via WARP.
  curl -s --max-time 12 --socks5-hostname "$PROXY_ADDR" \
    https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q '^warp=on$'
}

if setup_warp; then
  export MURDOCK_YT_PROXY="socks5://${PROXY_ADDR}"
  echo "murdock: WARP verified (warp=on) — YouTube-bound grabs routed through WARP"
else
  echo "murdock: WARP unavailable (Render may block its UDP) — YouTube disabled, other sources work"
fi

exec node /app/server.js
