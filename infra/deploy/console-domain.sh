#!/usr/bin/env bash
# Включение адреса консоли техподдержки — console.anthill.team (ТЗ-8).
#
# Зачем скрипт, а не «сходил руками»: шаг делается редко, а ошибиться в нём легко —
# выпустить сертификат до A-записи нельзя, а добавить в nginx путь к ещё не выпущенному
# сертификату значит уронить весь сайт. Здесь порядок зафиксирован и проверяется.
#
# Что делает:
#   1) убеждается, что console.anthill.team уже указывает на ЭТОТ сервер;
#   2) расширяет существующий сертификат anthill.team новым именем (webroot, без
#      остановки nginx — ACME-челлендж отдаёт тот же контейнер);
#   3) мягко перечитывает конфигурацию edge-nginx: живые соединения не рвутся.
#
# Имя уже стоит в server_name основного сервера (nginx/conf.d/default.conf), поэтому
# после расширения сертификата ничего править не нужно — только reload.
#
# Запуск на сервере:  bash /opt/teamcrm/deploy/console-domain.sh
set -euo pipefail

DOMAIN="${CONSOLE_DOMAIN:-console.anthill.team}"
BASE="${BASE_DOMAIN:-anthill.team}"
WEBROOT=/opt/teamcrm/nginx/html
COMPOSE_DIR=/opt/teamcrm

say() { echo "[console-domain] $*"; }

# ── 1. A-запись ──
# Сверяем с внешним адресом самого сервера: сертификат не выпустится, пока имя не
# ведёт сюда, а сообщение certbot об этом читается хуже, чем эта проверка.
want=$(curl -fsS --max-time 10 https://api.ipify.org || true)
got=$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || true)
if [ -z "$got" ]; then
  say "ОСТАНОВЛЕНО: $DOMAIN не разрешается. Заведите A-запись на ${want:-адрес сервера} и повторите."
  exit 1
fi
if [ -n "$want" ] && [ "$got" != "$want" ]; then
  say "ОСТАНОВЛЕНО: $DOMAIN ведёт на $got, а сервер — $want. Дождитесь обновления DNS."
  exit 1
fi
say "A-запись на месте: $DOMAIN → $got"

# ── 2. сертификат ──
# --expand добавляет имя в СУЩЕСТВУЮЩИЙ сертификат anthill.team, а не заводит второй:
# один файл на все имена сайта проще обновлять и невозможно перепутать в конфигурации.
say "расширяем сертификат $BASE именем $DOMAIN"
sudo certbot certonly --webroot -w "$WEBROOT" \
  --cert-name "$BASE" -d "$BASE" -d "www.$BASE" -d "$DOMAIN" \
  --expand --non-interactive --agree-tos --keep-until-expiring

# ── 3. мягкий reload ──
# Именно reload, а не restart: перезапуск edge рвёт все соединения разом — созвоны,
# сокеты, загрузки файлов, — и на секунду вся CRM отвечает 502.
say "перечитываем конфигурацию nginx"
cd "$COMPOSE_DIR"
docker compose exec -T crm-edge nginx -t
docker compose exec -T crm-edge nginx -s reload

say "готово: https://$DOMAIN открывает консоль техподдержки"
