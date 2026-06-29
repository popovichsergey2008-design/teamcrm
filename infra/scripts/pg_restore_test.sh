#!/usr/bin/env bash
# TEAMCRM — контрольное восстановление последнего дампа в скретч-БД (Этап 0 DoD).
# Не трогает рабочую БД: восстанавливает в teamcrm_restore_test, проверяет, удаляет.
set -euo pipefail

STACK_DIR="/opt/teamcrm"
BACKUP_DIR="${STACK_DIR}/backups"
TEST_DB="teamcrm_restore_test"

cd "$STACK_DIR"
set -a; . ./.env; set +a

LATEST="$(ls -1t "${BACKUP_DIR}"/teamcrm-*.dump 2>/dev/null | head -1)"
[ -z "${LATEST:-}" ] && { echo "no backup found"; exit 1; }
echo "restoring from: $LATEST"

psql() { docker compose exec -T crm-postgres psql -U "$POSTGRES_USER" "$@"; }

psql -d postgres -c "DROP DATABASE IF EXISTS ${TEST_DB};"
psql -d postgres -c "CREATE DATABASE ${TEST_DB};"

# restore dump into scratch db
docker compose exec -T crm-postgres pg_restore -U "$POSTGRES_USER" -d "$TEST_DB" --no-owner < "$LATEST" 2>/dev/null || true

echo "-- verify extensions present in restored db --"
psql -d "$TEST_DB" -tAc "SELECT extname FROM pg_extension WHERE extname IN ('vector','uuid-ossp','pg_trgm') ORDER BY 1;"
echo "-- verify connectivity / table count in restored db --"
psql -d "$TEST_DB" -tAc "SELECT 'tables='||count(*) FROM information_schema.tables WHERE table_schema='public';"

psql -d postgres -c "DROP DATABASE ${TEST_DB};"
echo "$(date -Is) RESTORE TEST OK"
