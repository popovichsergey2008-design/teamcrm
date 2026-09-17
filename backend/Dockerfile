# TEAMCRM backend — multi-stage build (NestJS)

# Стадия компиляции TypeScript. Опциональные зависимости здесь не нужны:
# типы mediasoup мы намеренно не импортируем (см. modules/media/media.types.ts),
# поэтому сборка не ждёт установки нативного воркера.
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=optional
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Продакшен-зависимости. mediasoup тянет готовый бинарник воркера, а при недоступности
# собирает его из исходников — поэтому здесь есть python3 и компилятор.
# В финальный образ инструменты не попадают: переносим только node_modules.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip build-essential \
 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# mediasoup ставится ОТДЕЛЬНО и намеренно.
# Он лежит в optionalDependencies (иначе не поставить под Windows, где идёт разработка),
# а `npm ci` опциональные зависимости из нашего lock-файла молча пропускает: ни ошибки,
# ни каталога — образ уезжал на прод без звонков и без единого слова в логе сборки.
# Ставим в отдельный каталог и вливаем в node_modules, а затем ПРОВЕРЯЕМ бинарник:
# сборка должна падать громко, а не оставлять сюрприз на потом.
RUN mkdir -p /ms && cd /ms && npm init -y >/dev/null \
 && npm i mediasoup@3.14.14 --no-audit --no-fund \
 && cp -rn /ms/node_modules/. /app/node_modules/ \
 && rm -rf /ms /root/.npm \
 && test -x /app/node_modules/mediasoup/worker/out/Release/mediasoup-worker \
 && echo "mediasoup worker: OK"

FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
# ffmpeg — извлечение аудиодорожки и нарезка записи встречи на куски под лимит Whisper (25 МБ)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
# Справочник по системе: из него служба заботы наполняет базу знаний.
COPY handbook ./handbook
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
