#!/usr/bin/env bash
# TEAMCRM — автоматический дамп PostgreSQL (Этап 0).
# Политика хранения: daily — 14 шт, weekly(вс) — 8 шт.
set -euo pipefail

STACK_DIR="/opt/teamcrm"
BACKUP_DIR="${STACK_DIR}/backups"
RETENTION_DAILY=14
RETENTION_WEEKLY=8

cd "$STACK_DIR"
set -a; . ./.env; set +a
mkdir -p "$BACKUP_DIR"

TS="$(date +%Y%m%d-%H%M%S)"
DOW="$(date +%u)"   # 7 = sunday
OUT="${BACKUP_DIR}/teamcrm-${TS}.dump"

# custom-format dump (compressed, restorable with pg_restore)
docker compose exec -T crm-postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$OUT"

# weekly snapshot on Sundays
if [ "$DOW" = "7" ]; then
  cp "$OUT" "${BACKUP_DIR}/weekly-teamcrm-${TS}.dump"
fi

# retention (|| true: пустой glob не должен валить скрипт под set -e/pipefail)
{ ls -1t "${BACKUP_DIR}"/teamcrm-*.dump 2>/dev/null || true; } | tail -n +$((RETENTION_DAILY+1)) | xargs -r rm -f
{ ls -1t "${BACKUP_DIR}"/weekly-teamcrm-*.dump 2>/dev/null || true; } | tail -n +$((RETENTION_WEEKLY+1)) | xargs -r rm -f

echo "$(date -Is) backup OK: $OUT ($(du -h "$OUT" | cut -f1))"
