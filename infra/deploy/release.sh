#!/usr/bin/env bash
#
# Выкладка TEAMCRM без разрыва.
#
# Раньше выкладка выглядела так: собрать образы, `docker compose up -d`, затем
# `docker compose restart crm-edge`. Последняя строка и была главной бедой —
# перезапуск пограничного nginx рвал ВСЕ соединения разом: созвоны, сокеты,
# загрузку файлов, — и на секунду-две вся CRM отвечала 502. Люди в это время
# работали.
#
# Теперь три правила:
#   1. Ждём, пока закончатся созвоны. Перезапуск API обрывает разговор: состояние
#      комнаты живёт в памяти процесса, и новый контейнер его не подхватит.
#   2. Пограничный nginx НЕ перезапускается. Он сам перечитывает адреса контейнеров
#      (резолвер докера), а изменения конфигурации применяются мягкой перезагрузкой,
#      при которой старые соединения доживают своё.
#   3. Ждём здоровья контейнеров и падаем, если оно не наступило: молча уехавшая
#      сломанная выкладка хуже честно упавшей.
#
# Запуск: bash /opt/teamcrm/deploy/release.sh
set -euo pipefail

cd /opt/teamcrm

# Сколько всего ждать окончания созвонов. Дольше держать выкладку смысла нет:
# разговор может идти час, а изменения нужны сегодня.
MAX_WAIT_MIN="${DEPLOY_MAX_WAIT_MIN:-10}"
STEP_SEC=30
STEPS=$(( MAX_WAIT_MIN * 60 / STEP_SEC ))

say() { echo "[release] $*"; }

# Windows-переводы строк ломают запуск точки входа в контейнере.
sed -i "s/\r$//" backend/docker/entrypoint.sh

say "сборка образов (старые контейнеры продолжают работать)"
docker compose build crm-api crm-web

# ── ждём тишины ───────────────────────────────────────────────────────────────
# Спрашиваем у самого API, говорит ли кто-нибудь. Ответ отдаётся только на запрос
# с самой машины, снаружи ручка закрыта.
busy_now() {
  docker compose exec -T crm-api node /tmp/deploy-busy.js 2>/dev/null || echo 0
}

# Скрипт-вопрос кладём в контейнер на лету: держать его в образе ради выкладки незачем.
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
if ! docker compose cp /tmp/deploy-busy.js crm-api:/tmp/deploy-busy.js >/dev/null 2>&1; then
  # Не смогли положить вопрос в контейнер — значит про созвоны мы не узнаем.
  # Это не повод останавливать выкладку, но и молчать об этом нельзя.
  say "ВНИМАНИЕ: не удалось проверить созвоны — выкладываем не дожидаясь тишины"
fi

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

# ── подъём ────────────────────────────────────────────────────────────────────
# --wait: команда возвращается только когда контейнеры стали healthy. Без него
# выкладка «успешна» ровно в тот момент, когда приложение ещё не поднялось.
say "поднимаем контейнеры и ждём здоровья"
docker compose up -d --wait --wait-timeout 240

# ── пограничный nginx: мягкая перезагрузка вместо перезапуска ────────────────
# Сначала проверка конфигурации: с битым конфигом reload не делаем вовсе, и
# продолжает работать прежний — это лучше, чем упавший nginx на проде.
say "проверяем и перечитываем конфигурацию nginx (соединения не рвутся)"
docker compose exec -T crm-edge nginx -t
docker compose exec -T crm-edge nginx -s reload

# ── проверки, что выложилось именно то ────────────────────────────────────────
# Знак приложения должен быть В ОБРАЗЕ: сборка проходит и без него, а на сайте
# по адресу иконки молча отдаётся оболочка приложения.
docker compose exec -T crm-web test -f /usr/share/nginx/html/favicon-32.png
docker compose exec -T crm-web test -f /usr/share/nginx/html/apple-touch-icon.png
docker compose exec -T crm-web test -f /usr/share/nginx/html/logo-mark.png

# Живой ответ через сам nginx: контейнеры бывают «здоровы» по отдельности, а
# снаружи при этом 502 — проверяем ровно тот путь, которым ходят люди.
say "проверяем ответ снаружи"
for i in $(seq 1 10); do
  code="$(docker compose exec -T crm-edge wget -qO- -S http://127.0.0.1/healthz 2>&1 | awk '/HTTP\//{print $2; exit}')"
  if [ "$code" = "200" ]; then break; fi
  if [ "$i" = "10" ]; then say "nginx не отвечает 200 на /healthz"; exit 1; fi
  sleep 2
done

docker compose ps
say "готово"
