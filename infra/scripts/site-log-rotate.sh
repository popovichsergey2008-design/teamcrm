#!/bin/sh
# #4804, часть 1: журнал сайта qevo.one — раз в сутки (00:05 МСК, cron root) из
# контейнера edge-nginx на хост архивом .gz. nginx не перезапускаем: mv + reopen —
# открытые соединения и созвоны не рвутся.
#
# Архивы: /opt/teamcrm/logs/site/qevo-site-ГГГГ-ММ-ДД.log.gz (за прошедшие сутки),
# храним 60 дней. Их и разбирает scripts/utm_weekly.py.
set -eu
D=${SITE_LOG_DIR:-/opt/teamcrm/logs/site}
E=$(docker ps --format '{{.Names}}' | grep -E 'crm-edge' | head -1)
[ -n "$E" ] || { echo "edge-nginx не найден" >&2; exit 1; }
mkdir -p "$D"
DAY=$(date -d yesterday +%F)
# журнала нет (контейнер только что пересоздан) — уносить нечего
docker exec "$E" sh -c 'test -s /var/log/nginx/qevo-site.log' || exit 0
docker exec "$E" sh -c 'mv /var/log/nginx/qevo-site.log /var/log/nginx/qevo-site.log.1 && nginx -s reopen'
sleep 2
# >> — повторный запуск в те же сутки дописывает (gzip читает склеенные архивы)
docker exec "$E" cat /var/log/nginx/qevo-site.log.1 | gzip >> "$D/qevo-site-$DAY.log.gz"
docker exec "$E" rm -f /var/log/nginx/qevo-site.log.1
find "$D" -name 'qevo-site-*.log.gz' -mtime +60 -delete
