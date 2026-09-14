#!/usr/bin/env bash
#
# Выкладка TEAMCRM без разрыва — сине-зелёная.
#
# История. Сначала выкладка перезапускала пограничный nginx и рвала ВСЕ
# соединения. Это починили: nginx перечитывает адреса сам и перезагружается
# мягко. Но API оставался одним контейнером, и его пересоздание — миграции,
# старт Nest — давало секунд пятнадцать сплошных 502. Заказчик написал
# «502 ошибка» ровно в такую минуту: в журнале nginx — шестьдесят отказов.
#
# Теперь работают два цвета, синий и зелёный (см. docker-compose.yml):
#   1. Ждём, пока закончатся созвоны: их состояние живёт в памяти процесса,
#      и новый контейнер его не подхватит.
#   2. Поднимаем НЕактивный цвет рядом с живым и ждём его здоровья. Миграции
#      он накатывает сам, пока старый продолжает отвечать: все наши миграции
#      только добавляют — старый код от них не ломается.
#   3. Переключаем nginx на новый цвет мягкой перезагрузкой — соединения не рвутся.
#   4. Проверяем ответ снаружи и только потом гасим прежний цвет.
#   5. Падаем, если здоровье не наступило: старый цвет при этом продолжает
#      работать, и люди ничего не замечают.
#
# Какой цвет живой, хранится в state/color.inc — этот каталог не синхронизируется
# из репозитория, иначе каждая выкладка сбрасывала бы выбор.
#
# Запуск: bash /opt/teamcrm/deploy/release.sh
set -euo pipefail

cd /opt/teamcrm

MAX_WAIT_MIN="${DEPLOY_MAX_WAIT_MIN:-10}"
STEP_SEC=30
STEPS=$(( MAX_WAIT_MIN * 60 / STEP_SEC ))
STATE_DIR=/opt/teamcrm/state
COLOR_FILE="$STATE_DIR/color.inc"

say() { echo "[release] $*"; }

# Оба профиля всегда: без них compose не знает сервисов другого цвета
# и отвечает «no such service» даже на просьбу их остановить.
dc() { docker compose --profile blue --profile green "$@"; }

# Windows-переводы строк ломают запуск точки входа в контейнере.
sed -i "s/\r$//" backend/docker/entrypoint.sh

# ── какой цвет живой ──────────────────────────────────────────────────────────
mkdir -p "$STATE_DIR"
if [ -f "$COLOR_FILE" ] && grep -q 'crm-api-green' "$COLOR_FILE"; then
  OLD=green; NEW=blue
elif [ -f "$COLOR_FILE" ] && grep -q 'crm-api-blue' "$COLOR_FILE"; then
  OLD=blue; NEW=green
else
  # Первый запуск: живут ещё «бесцветные» crm-api и crm-web из прежней схемы.
  # Поднимаем ЗЕЛЁНЫЙ: у прежнего API те же RTP-порты, что у синего, и синий
  # рядом с ним не стартует.
  OLD=legacy; NEW=green
  say "файла цвета нет — считаем, что работает прежняя схема, поднимаем зелёный"
fi
say "живой цвет: $OLD → поднимаем: $NEW"

# Контейнер живого API — чтобы спросить его о созвонах. У прежней схемы имя без цвета.
active_api() {
  docker ps --format '{{.Names}}' | grep -E "^teamcrm-crm-api(-${OLD})?-1$" | head -1 || true
}

# RTP зелёного цвета — свой диапазон портов, и файрвол о нём ещё не знает:
# правило для 40000–40040 ставилось руками при развёртывании. Без этого созвон
# через зелёный API не соберётся. Идемпотентно: ufw повторное правило не дублирует.
if command -v ufw >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n ufw allow 40041:40081/udp comment 'mediasoup RTP (green)' >/dev/null 2>&1 \
    || say "ВНИМАНИЕ: не удалось открыть 40041–40081/udp в ufw — созвоны через зелёный цвет могут не собраться"
fi

say "сборка образов (живые контейнеры продолжают работать)"
dc build "crm-api-$NEW" "crm-web-$NEW"

# ── ждём тишины ───────────────────────────────────────────────────────────────
cat > /tmp/deploy-busy.js <<BUSY
const http = require("http");
http.get("http://127.0.0.1:3000/api/health/busy", (r) => {
  let d = "";
  r.on("data", (c) => { d += c; });
  r.on("end", () => {
    try { console.log(Number(JSON.parse(d).data.participants) || 0); }
    catch (e) { console.log(0); }
  });
}).on("error", () => console.log(0));
BUSY
busy_now() {
  local c; c="$(active_api)"
  if [ -z "$c" ]; then echo 0; return; fi
  docker cp /tmp/deploy-busy.js "$c:/tmp/deploy-busy.js" >/dev/null 2>&1 || { echo 0; return; }
  docker exec "$c" node /tmp/deploy-busy.js 2>/dev/null || echo 0
}

waited=0
for _ in $(seq 1 "$STEPS"); do
  n="$(busy_now | tr -dc '0-9')"
  n="${n:-0}"
  if [ "$n" = "0" ]; then break; fi
  say "идёт созвон: участников $n — ждём ${STEP_SEC} с (всего ждём не дольше ${MAX_WAIT_MIN} мин)"
  sleep "$STEP_SEC"
  waited=$(( waited + STEP_SEC ))
done
if [ "$waited" -ge $(( MAX_WAIT_MIN * 60 )) ]; then
  say "ВНИМАНИЕ: созвон всё ещё идёт, но ждать дольше нельзя — выкладываем"
fi

# ── новый цвет — рядом с живым ────────────────────────────────────────────────
# Файл цвета обязан существовать до старта nginx: без него конфигурация не
# проходит проверку. На первом запуске пишем в него ПРЕЖНИЙ цвет — переключим
# после того, как новый станет здоров.
if [ ! -f "$COLOR_FILE" ]; then
  printf 'set $api_upstream crm-api:3000;\nset $web_upstream crm-web:80;\n' > "$COLOR_FILE"
fi

say "поднимаем хранилища, nginx и цвет $NEW; ждём здоровья"
# --wait: команда возвращается только когда контейнеры стали healthy. Без него
# выкладка «успешна» ровно в тот момент, когда приложение ещё не поднялось.
docker compose --profile "$NEW" up -d --wait --wait-timeout 240

# ── переключение ──────────────────────────────────────────────────────────────
say "переключаем nginx на $NEW (мягкая перезагрузка, соединения не рвутся)"
printf 'set $api_upstream crm-api-%s:3000;\nset $web_upstream crm-web-%s:80;\n' "$NEW" "$NEW" > "$COLOR_FILE"
# С битым конфигом reload не делаем вовсе: продолжает работать прежний — это
# лучше, чем упавший nginx на проде.
dc exec -T crm-edge nginx -t
dc exec -T crm-edge nginx -s reload

# ── проверки, что выложилось именно то ────────────────────────────────────────
# Знак приложения должен быть В ОБРАЗЕ: сборка проходит и без него, а на сайте
# по адресу иконки молча отдаётся оболочка приложения.
dc exec -T "crm-web-$NEW" test -f /usr/share/nginx/html/favicon-32.png
dc exec -T "crm-web-$NEW" test -f /usr/share/nginx/html/apple-touch-icon.png
dc exec -T "crm-web-$NEW" test -f /usr/share/nginx/html/logo-mark.png

# Живой ответ через сам nginx — ровно тем путём, которым ходят люди, и до
# самого API, а не только до nginx: контейнеры бывают «здоровы» по отдельности,
# а снаружи при этом 502. Проверяем кодом возврата, не разбором заголовков.
say "проверяем ответ снаружи через новый цвет"
ok=0
for i in $(seq 1 15); do
  # Второй запрос — из nginx к новому API по имени: ровно тот путь, которым nginx
  # пойдёт за каждым запросом людей (резолвер докера + порт 3000).
  if dc exec -T crm-edge wget -q -O /dev/null http://127.0.0.1/healthz \
     && dc exec -T crm-edge wget -q -O /dev/null "http://crm-api-$NEW:3000/api/health"; then
    ok=1; break
  fi
  say "новый цвет ещё не отвечает через nginx (попытка $i из 15)"
  sleep 2
done
if [ "$ok" != "1" ]; then
  # Откат — одной строкой: возвращаем прежний цвет в файл и перечитываем.
  say "новый цвет не отвечает — возвращаем $OLD и останавливаем $NEW"
  if [ "$OLD" = "legacy" ]; then
    printf 'set $api_upstream crm-api:3000;\nset $web_upstream crm-web:80;\n' > "$COLOR_FILE"
  else
    printf 'set $api_upstream crm-api-%s:3000;\nset $web_upstream crm-web-%s:80;\n' "$OLD" "$OLD" > "$COLOR_FILE"
  fi
  dc exec -T crm-edge nginx -s reload || true
  dc stop "crm-api-$NEW" "crm-web-$NEW" || true
  exit 1
fi

# ── гасим прежний цвет ────────────────────────────────────────────────────────
# Сокеты, висевшие на старом API, переподключатся к новому сами: страница
# после reconnect перечитывает открытое. Созвонов к этому моменту нет — ждали.
say "гасим прежний цвет: $OLD"
if [ "$OLD" = "legacy" ]; then
  # Контейнеры прежней схемы compose уже не знает — убираем напрямую.
  docker rm -f teamcrm-crm-api-1 teamcrm-crm-web-1 >/dev/null 2>&1 || true
else
  dc stop "crm-api-$OLD" "crm-web-$OLD"
fi

dc ps
say "готово: живой цвет — $NEW"
