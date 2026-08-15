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

# Продакшен-зависимости, включая mediasoup. Он тянет готовый бинарник воркера,
# но при недоступности собирает его из исходников — поэтому здесь есть python3 и компилятор.
# В финальный образ эти инструменты не попадают: переносим только node_modules.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip build-essential \
 && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

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
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
