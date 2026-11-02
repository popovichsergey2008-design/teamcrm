#!/usr/bin/env bash
# Тестовая среда dev.qevo.one на этом же сервере (02.11, ТЗ консолей §8).
#
# Идемпотентно: первый запуск заводит всё, следующие (после каждой выкладки, из
# release.sh) только обновляют dev-API до нового образа. Боевое не трогает:
#   * Postgres — база teamcrm_dev и пользователь teamcrm_dev (НЕ суперпользователь);
#     у боевой базы отбирается право входа «для всех» (PUBLIC) — владелец входит как раньше;
#   * RabbitMQ — vhost dev и пользователь только с правами на него (иначе dev забирал
#     бы задания из боевых очередей);
#   * MinIO — пользователь teamcrm-dev с доступом к одной корзине teamcrm-dev;
#   * Redis — свой контейнер crm-redis-dev.
# Пароли генерируются один раз и дописываются в .env (DEV_*), на экран не выводятся.
# Сбой этого скрипта прод не роняет: release.sh зовёт его последним и не падает.
set -euo pipefail
cd /opt/teamcrm

say() { echo "[dev-env] $*"; }
ENV=.env

# ── пароли среды ──
gen() { openssl rand -hex 24; }
for k in DEV_POSTGRES_PASSWORD DEV_REDIS_PASSWORD DEV_RABBITMQ_PASSWORD DEV_MINIO_PASSWORD DEV_JWT_ACCESS_SECRET DEV_JWT_REFRESH_SECRET; do
  if ! grep -q "^${k}=" "$ENV"; then
    printf '%s=%s\n' "$k" "$(gen)" >> "$ENV"
    say "создан $k"
  fi
done
grep -q '^DEV_MINIO_USER=' "$ENV" || printf 'DEV_MINIO_USER=teamcrm-dev\n' >> "$ENV"

# только нужные значения: .env целиком не исполняем (в нём JSON и строки с пробелами)
val() { grep -m1 "^$1=" "$ENV" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
POSTGRES_USER="$(val POSTGRES_USER)"; POSTGRES_DB="$(val POSTGRES_DB)"
DEV_POSTGRES_PASSWORD="$(val DEV_POSTGRES_PASSWORD)"; DEV_RABBITMQ_PASSWORD="$(val DEV_RABBITMQ_PASSWORD)"
DEV_MINIO_USER="$(val DEV_MINIO_USER)"; DEV_MINIO_PASSWORD="$(val DEV_MINIO_PASSWORD)"

PG="docker compose exec -T crm-postgres psql -v ON_ERROR_STOP=1 -U $POSTGRES_USER"

# ── Postgres ──
$PG -d "$POSTGRES_DB" -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'teamcrm_dev') THEN
    CREATE ROLE teamcrm_dev LOGIN PASSWORD '${DEV_POSTGRES_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE teamcrm_dev LOGIN PASSWORD '${DEV_POSTGRES_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END \$\$;
REVOKE CONNECT ON DATABASE "${POSTGRES_DB}" FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
SQL
if [ "$($PG -d "$POSTGRES_DB" -tAc "SELECT 1 FROM pg_database WHERE datname='teamcrm_dev'")" != "1" ]; then
  $PG -d "$POSTGRES_DB" -q -c "CREATE DATABASE teamcrm_dev OWNER teamcrm_dev"
  say "создана база teamcrm_dev"
fi
# расширения ставит суперпользователь: у teamcrm_dev прав на это нет, и миграции их только «проверяют»
$PG -d teamcrm_dev -q <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
REVOKE CONNECT ON DATABASE teamcrm_dev FROM PUBLIC;
GRANT CONNECT ON DATABASE teamcrm_dev TO teamcrm_dev;
SQL

# ── RabbitMQ ──
RMQ="docker compose exec -T crm-rabbitmq rabbitmqctl -q"
$RMQ list_vhosts | grep -qx dev || { $RMQ add_vhost dev; say "создан vhost dev"; }
if $RMQ list_users | awk '{print $1}' | grep -qx teamcrm_dev; then
  $RMQ change_password teamcrm_dev "$DEV_RABBITMQ_PASSWORD" >/dev/null
else
  $RMQ add_user teamcrm_dev "$DEV_RABBITMQ_PASSWORD" >/dev/null
  say "создан пользователь RabbitMQ teamcrm_dev"
fi
$RMQ set_permissions -p dev teamcrm_dev '.*' '.*' '.*' >/dev/null

# ── MinIO ──
docker compose exec -T -e DEVPASS="$DEV_MINIO_PASSWORD" -e DEVUSER="$DEV_MINIO_USER" crm-minio sh -s <<'SH'
set -e
mc alias set l http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing l/teamcrm-dev >/dev/null
cat > /tmp/teamcrm-dev-policy.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::teamcrm-dev","arn:aws:s3:::teamcrm-dev/*"]}]}
JSON
mc admin user add l "$DEVUSER" "$DEVPASS" >/dev/null
mc admin policy create l teamcrm-dev /tmp/teamcrm-dev-policy.json >/dev/null 2>&1 || true
mc admin policy attach l teamcrm-dev --user "$DEVUSER" >/dev/null 2>&1 || true
rm -f /tmp/teamcrm-dev-policy.json
SH

# ── контейнеры dev: новый образ после каждой выкладки ──
say "поднимаем dev-API"
# --no-deps: боевые Postgres и RabbitMQ не пересоздаются ни при каких условиях
docker compose --profile dev up -d --no-deps --force-recreate --wait --wait-timeout 60 crm-redis-dev
docker compose --profile dev up -d --no-deps --force-recreate --wait --wait-timeout 240 crm-api-dev
say "готово: dev.qevo.one ходит в свою базу teamcrm_dev"
