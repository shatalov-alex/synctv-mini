#!/usr/bin/env bash
# Runs on the development machine. Builds everything the VPS needs into one private archive:
#   deploy/vps/make-bundle.sh [amd64|arm64]
# The archive holds live secrets. It is written to deploy/vps/out/ (git-ignored), mode 600.
set -euo pipefail

arch="${1:-amd64}"
case "$arch" in amd64 | arm64) ;; *) echo "usage: $0 [amd64|arm64]" >&2; exit 1 ;; esac

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
source_env="$root/.env.synctv"
cf_dir="$HOME/.cloudflared"
out="$here/out"
stage="$out/synctv"
image="synctv-lite:vps-$arch"
umask 077

# Only these three carry over: the bot and Telegram depend on them. Everything else is new,
# because the VPS starts with an empty database.
read_env() {
  local value
  value="$(sed -n "s/^$1=//p" "$source_env")"
  [ -n "$value" ] || { echo "$1 is missing from $source_env" >&2; exit 1; }
  printf '%s' "$value"
}
bot_token="$(read_env SYNCTV_TELEGRAM_BOT_TOKEN)"
admin_id="$(read_env SYNCTV_TELEGRAM_ADMIN_USER_ID)"
service_key="$(read_env SYNCTV_SERVICE_API_KEY)"

tunnel_id="$(sed -n 's/^tunnel: *//p' "$cf_dir/config.yml")"
[ -f "$cf_dir/$tunnel_id.json" ] || { echo "No credentials for tunnel in $cf_dir" >&2; exit 1; }

docker buildx build --platform "linux/$arch" -f "$here/Dockerfile" -t "$image" --load "$root"

rm -rf "$stage"
mkdir -p "$stage/env" "$stage/cloudflared"

echo "Building the client"
(cd "$root/lite-client" && npx vite build --outDir "$stage/lite-client" --emptyOutDir)

echo "Saving the image"
docker tag "$image" synctv-lite:vps
docker save synctv-lite:vps | gzip -1 >"$stage/image.tar.gz"
echo "$arch" >"$stage/image-arch"

hex() { openssl rand -hex 32; }
pg_password="$(hex)"
redis_password="$(hex)"

cat >"$stage/env/postgres.env" <<ENV
POSTGRES_USER=synctv
POSTGRES_PASSWORD=$pg_password
POSTGRES_DB=synctv
ENV

cat >"$stage/env/redis.env" <<ENV
REDIS_PASSWORD=$redis_password
ENV

cat >"$stage/env/synctv.env" <<ENV
SYNCTV_DATABASE_URL=postgresql://synctv:$pg_password@postgres:5432/synctv
SYNCTV_REDIS_URL=redis://:$redis_password@redis:6379
SYNCTV_JWT_SECRET=$(hex)
SYNCTV_CLUSTER_SECRET=$(hex)
SYNCTV_SECURITY_CREDENTIAL_ENCRYPTION_KEY=$(hex)
SYNCTV_SECURITY_TOTP_ENCRYPTION_KEY=$(hex)
SYNCTV_SECURITY_EMAIL_OUTBOX_ENCRYPTION_KEY=$(hex)
SYNCTV_SECURITY_OPAQUE_SERVER_SETUP_SECRET=$(hex)
SYNCTV_SECURITY_PROXY_SIGNING_KEY=$(hex)
SYNCTV_SECURITY_MEDIA_SWARM_SIGNING_KEY=$(hex)
SYNCTV_SECURITY_PROVIDER_SESSION_ENCRYPTION_KEY=$(hex)
SYNCTV_SECURITY_LOGIN_DISCOVERY_KEY=$(hex)
SYNCTV_SECURITY_WEBAUTHN_ENUMERATION_KEY=$(hex)
SYNCTV_FILE_UPLOAD_TOKEN_SECRET=$(hex)
SYNCTV_BOOTSTRAP_CREATE_ROOT_USER=true
SYNCTV_BOOTSTRAP_ROOT_USERNAME=root
SYNCTV_BOOTSTRAP_ROOT_PASSWORD=Root-$(hex)

SYNCTV_TELEGRAM_BOT_TOKEN=$bot_token
SYNCTV_TELEGRAM_ADMIN_USER_ID=$admin_id
SYNCTV_TELEGRAM_WEB_APP_URL=https://synctv.shatalov.co
SYNCTV_TELEGRAM_BOT_POLLING_ENABLED=false
SYNCTV_SERVICE_API_KEY=$service_key

# Video goes through the server, so it must not be able to reach private addresses,
# which on a VPS include the provider's metadata service.
SYNCTV_MEDIA_DIRECT_URL_DEFAULT_PROXY_MODE=only
SYNCTV_SECURITY_SSRF_ENABLED=true
SYNCTV_SECURITY_SSRF_ALLOW_PRIVATE_NETWORK_TARGETS=false

# Low memory: small pools and caches, and nothing this deployment does not use.
TOKIO_WORKER_THREADS=2
SYNCTV_DATABASE_MAX_CONNECTIONS=8
SYNCTV_DATABASE_MIN_CONNECTIONS=1
SYNCTV_CACHE_L1_CAPACITY=1000
SYNCTV_CACHE_USERNAME_CACHE_CAPACITY=1000
SYNCTV_PROXY_SLICE_CACHE_MAX_CACHE_SIZE_BYTES=134217728
SYNCTV_LIVESTREAM_WEBRTC_ENABLED=false
SYNCTV_WEBRTC_ENABLE_BUILTIN_STUN=false
SYNCTV_METRICS_ENABLED=false
SYNCTV_CLUSTER_ENABLED=false
ENV

cp "$cf_dir/$tunnel_id.json" "$stage/cloudflared/credentials.json"
cat >"$stage/cloudflared/config.yml" <<YAML
tunnel: $tunnel_id
credentials-file: /etc/cloudflared/credentials.json
no-autoupdate: true

ingress:
  - hostname: synctv.shatalov.co
    service: http://synctv:8080
  - service: http_status:404
YAML

cp "$here/docker-compose.yml" "$here/prepare-server.sh" "$here/install.sh" "$here/README.md" "$stage/"
chmod +x "$stage/prepare-server.sh" "$stage/install.sh"

tar -C "$out" -czf "$out/synctv-vps-$arch.tar.gz" synctv
chmod 600 "$out/synctv-vps-$arch.tar.gz"
rm -rf "$stage"
echo "Ready: $out/synctv-vps-$arch.tar.gz"
