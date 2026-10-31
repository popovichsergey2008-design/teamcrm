#!/usr/bin/env bash
# Адреса консолей платформы в сертификате qevo.one: owner / developer / support (31.10).
#
# В отличие от console-domain.sh список имён НЕ зашит: берём все имена из действующего
# сертификата и добавляем новые. Зашитый список однажды устарел (в нём нет app и db) —
# запуск старого скрипта выпустил бы сертификат без app.qevo.one и уронил CRM.
#
# Запуск на сервере:  bash /opt/teamcrm/deploy/platform-domains.sh
set -euo pipefail

BASE="${BASE_DOMAIN:-qevo.one}"
NEW="${PLATFORM_DOMAINS:-owner.$BASE developer.$BASE support.$BASE}"
WEBROOT=/opt/teamcrm/nginx/html
COMPOSE_DIR=/opt/teamcrm
LIVE="/etc/letsencrypt/live/$BASE/cert.pem"

say() { echo "[platform-domains] $*"; }

want=$(curl -fsS --max-time 10 https://api.ipify.org || true)
for d in $NEW; do
  got=$(getent ahostsv4 "$d" | awk '{print $1; exit}' || true)
  if [ -z "$got" ] || { [ -n "$want" ] && [ "$got" != "$want" ]; }; then
    say "ОСТАНОВЛЕНО: $d ведёт на '${got:-никуда}', а сервер — ${want:-?}"
    exit 1
  fi
done

# Имена действующего сертификата — все до одного остаются.
current=$(sudo openssl x509 -in "$LIVE" -noout -ext subjectAltName | tr ',' '\n' | sed -n 's/.*DNS://p' | tr -d ' ')
if ! echo "$current" | grep -qx "app.$BASE"; then
  say "ОСТАНОВЛЕНО: в действующем сертификате нет app.$BASE — что-то не так, руками не продолжаю"
  exit 1
fi
all=$(printf '%s\n' $current $NEW | awk 'NF && !seen[$0]++')
args=""
for d in $all; do args="$args -d $d"; done
say "имена: $(echo $all)"

# shellcheck disable=SC2086
sudo certbot certonly --webroot -w "$WEBROOT" --cert-name "$BASE" $args \
  --expand --non-interactive --agree-tos --keep-until-expiring

cd "$COMPOSE_DIR"
docker compose exec -T crm-edge nginx -t
docker compose exec -T crm-edge nginx -s reload
say "готово: https://owner.$BASE, https://developer.$BASE, https://support.$BASE"
