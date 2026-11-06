#!/usr/bin/env bash
# Runs on the VPS from the unpacked bundle:
#   ./install.sh           load the image and start the app, without public traffic
#   ./install.sh go-live   start the tunnel: stop the old machine's tunnel first
#   ./install.sh go-dark   stop the tunnel again, to hand traffic back
set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose -p synctv-server "$@"; }

install_app() {
  local want have
  want="$(cat image-arch)"
  case "$(uname -m)" in
    x86_64) have=amd64 ;;
    aarch64) have=arm64 ;;
    *) have="$(uname -m)" ;;
  esac
  if [ "$want" != "$have" ]; then
    echo "This bundle is for $want but this server is $have. Run make-bundle.sh $have." >&2
    exit 1
  fi

  chmod 600 env/*.env
  # The cloudflared image runs as this user and has to read its credentials.
  chown -R 65532:65532 cloudflared 2>/dev/null || true
  chmod -R a+rX lite-client

  gunzip -c image.tar.gz | docker load
  compose up -d postgres redis synctv

  echo "Waiting for the app"
  for _ in $(seq 1 60); do
    if [ "$(docker inspect -f '{{.State.Health.Status}}' synctv-app)" = healthy ]; then
      check_app
      echo "App is healthy. Next: stop the old tunnel, then ./install.sh go-live"
      return
    fi
    sleep 5
  done
  docker logs --tail 40 synctv-app >&2
  echo "The app did not become healthy" >&2
  exit 1
}

check_app() {
  docker exec synctv-app curl -fsS -o /dev/null http://localhost:8080/
  docker exec synctv-app curl -fsS -o /dev/null http://localhost:8080/api/public/time
  echo "Client and API respond"
}

case "${1:-install}" in
  install) install_app ;;
  go-live)
    compose --profile tunnel up -d cloudflared
    echo "Tunnel started. Check https://synctv.shatalov.co"
    ;;
  go-dark) compose --profile tunnel stop cloudflared ;;
  *) echo "usage: $0 [install|go-live|go-dark]" >&2; exit 1 ;;
esac
