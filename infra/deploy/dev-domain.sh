#!/usr/bin/env bash
# Сертификат для dev.qevo.one — адреса нового интерфейса (ТЗ-15).
#
# Порядок тот же, что в console-domain.sh: имя уже стоит в server_name своего блока
# (nginx/conf.d/default.conf) и ссылается на сертификат qevo.one, так что nginx
# поднимается и без него — браузер лишь ругается на имя. Здесь сертификат расширяется
# новым именем, после чего мягкий reload — и адрес открывается без предупреждений.
#
# Все прежние имена перечислены явно: --expand с неполным списком их бы потерял.
#
# Запуск на сервере:  bash /opt/teamcrm/deploy/dev-domain.sh
set -euo pipefail

DOMAIN=dev.qevo.one
BASE=qevo.one
WEBROOT=/opt/teamcrm/nginx/html

say() { echo "[dev-domain] $*"; }

want=$(curl -fsS --max-time 10 https://api.ipify.org || true)
got=$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || true)
if [ -z "$got" ] || { [ -n "$want" ] && [ "$got" != "$want" ]; }; then
  say "ОСТАНОВЛЕНО: $DOMAIN ведёт на '${got:-никуда}', а сервер — ${want:-?}."
  exit 1
fi
say "A-запись на месте: $DOMAIN → $got"

sudo certbot certonly --webroot -w "$WEBROOT" \
  --cert-name "$BASE" -d "$BASE" -d "www.$BASE" -d "console.$BASE" -d "dev.$BASE" \
  --expand --non-interactive --agree-tos --keep-until-expiring

cd /opt/teamcrm
docker compose exec -T crm-edge nginx -t
docker compose exec -T crm-edge nginx -s reload
say "готово: https://$DOMAIN"
