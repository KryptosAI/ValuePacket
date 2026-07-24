#!/bin/bash
# Persistent tunnel for ValuePacket price-feed — auto-restarts on disconnect.
# Run: ./scripts/tunnel-price-feed.sh
# Config lives in scripts/tunnel-price-feed.env

set -e

LOCAL_PORT="${LOCAL_PORT:-3000}"
REMOTE_PORT="${REMOTE_PORT:-80}"
LOG_FILE="${LOG_FILE:-/tmp/valuepacket-tunnel.log}"
URL_FILE="${URL_FILE:-/tmp/valuepacket-tunnel.url}"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

reconnect() {
  log "Establishing tunnel on port $LOCAL_PORT..."
  ssh -o StrictHostKeyChecking=no \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes \
      -R "${REMOTE_PORT}:localhost:${LOCAL_PORT}" \
      nokey@localhost.run 2>&1 | while IFS= read -r line; do
    echo "$line" >> "$LOG_FILE"
    if echo "$line" | grep -qo '[a-z0-9]\{12,16\}\.lhr\.life'; then
      URL="https://$(echo "$line" | grep -o '[a-z0-9]\{12,16\}\.lhr\.life')"
      echo "$URL" > "$URL_FILE"
      log "Tunnel live at $URL"
    fi
    if echo "$line" | grep -q "connection closed\|Connection to.*closed\|Write failed"; then
      log "Tunnel dropped — reconnecting in 5s..."
      break
    fi
  done
}

log "ValuePacket tunnel daemon starting (port $LOCAL_PORT → $REMOTE_PORT)"
while true; do
  if ! lsof -ti "tcp:$LOCAL_PORT" >/dev/null 2>&1; then
    log "WARNING: nothing listening on port $LOCAL_PORT — waiting..."
    sleep 10
    continue
  fi
  reconnect || log "SSH exited with $?"
  sleep 5
done
