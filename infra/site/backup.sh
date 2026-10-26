#!/usr/bin/env bash
# Ночная копия сайта компании: база WordPress и папка wp-content (темы, плагины,
# загрузки). Храним 14 дней. Запуск из cron пользователя deploy:
#   30 3 * * * bash /opt/qevo-site/backup.sh >> /opt/qevo-site/backups/backup.log 2>&1
set -euo pipefail
cd /opt/qevo-site
set -a; . ./.env; set +a
D=backups; mkdir -p "$D"
stamp=$(date +%F)
docker exec qevo-site-db mariadb-dump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction wordpress | gzip > "$D/db-$stamp.sql.gz"
tar -czf "$D/wp-content-$stamp.tgz" -C wp wp-content
find "$D" -name '*.gz' -mtime +14 -delete; find "$D" -name '*.tgz' -mtime +14 -delete
echo "$(date -Is) ok: $(du -sh "$D" | cut -f1)"
