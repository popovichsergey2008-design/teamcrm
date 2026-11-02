#!/usr/bin/env bash
# TEAMCRM — контрольное восстановление последнего дампа в скретч-БД (Этап 0 DoD).
# Не трогает рабочую БД: восстанавливает в teamcrm_restore_test, проверяет, удаляет.
#
# 02.11 (ТЗ консолей §4.2): итог пишется в backups/restore-test.json — консоль
# разработчика показывает его во вкладке «Выпуски и копии». Проверка строже:
# три расширения на месте и таблиц не меньше 100 — иначе FAIL, а не «OK» по факту
# того, что команда дошла до конца.
set -euo pipefail

STACK_DIR="/opt/teamcrm"
BACKUP_DIR="${STACK_DIR}/backups"
TEST_DB="teamcrm_restore_test"
RESULT="${BACKUP_DIR}/restore-test.json"
STARTED="$(date +%s)"

cd "$STACK_DIR"
# только нужное: .env целиком не исполняем (в нём бывают JSON и строки с пробелами)
POSTGRES_USER="$(grep -m1 '^POSTGRES_USER=' .env | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"

LATEST="$(ls -1t "${BACKUP_DIR}"/teamcrm-*.dump 2>/dev/null | head -1 || true)"

result() {  # result <ok:true|false> <сообщение> [таблиц] [расширений]
  python3 - "$RESULT" "$1" "$2" "${3:-0}" "${4:-0}" "$(basename "${LATEST:-нет}")" "$(( $(date +%s) - STARTED ))" <<'PY'
import json, sys, datetime
path, ok, msg, tables, ext, dump, secs = sys.argv[1:8]
json.dump({"ok": ok == "true", "message": msg, "tables": int(tables), "extensions": int(ext), "dump": dump,
           "seconds": int(secs), "at": datetime.datetime.now(datetime.timezone.utc).isoformat()},
          open(path, "w"), ensure_ascii=False)
PY
}
trap 'result false "сбой скрипта на строке $LINENO"' ERR

[ -z "${LATEST:-}" ] && { result false "копий нет"; echo "no backup found"; exit 1; }
echo "restoring from: $LATEST"

psql() { docker compose exec -T crm-postgres psql -U "$POSTGRES_USER" "$@"; }

psql -d postgres -c "DROP DATABASE IF EXISTS ${TEST_DB};"
psql -d postgres -c "CREATE DATABASE ${TEST_DB};"

# restore dump into scratch db
docker compose exec -T crm-postgres pg_restore -U "$POSTGRES_USER" -d "$TEST_DB" --no-owner < "$LATEST" 2>/dev/null || true

echo "-- verify extensions present in restored db --"
EXT="$(psql -d "$TEST_DB" -tAc "SELECT count(*) FROM pg_extension WHERE extname IN ('vector','uuid-ossp','pg_trgm');" | tr -dc '0-9')"
echo "extensions=${EXT}"
echo "-- verify connectivity / table count in restored db --"
TABLES="$(psql -d "$TEST_DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" | tr -dc '0-9')"
echo "tables=${TABLES}"

psql -d postgres -c "DROP DATABASE ${TEST_DB};"
trap - ERR

if [ "${EXT:-0}" -ge 3 ] && [ "${TABLES:-0}" -ge 100 ]; then
  result true "восстановилась: таблиц ${TABLES}, расширения на месте" "$TABLES" "$EXT"
  echo "$(date -Is) RESTORE TEST OK"
else
  result false "восстановилась не полностью: таблиц ${TABLES:-0}, расширений ${EXT:-0} из 3" "${TABLES:-0}" "${EXT:-0}"
  echo "$(date -Is) RESTORE TEST FAIL"
  exit 1
fi
