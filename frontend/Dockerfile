# TEAMCRM frontend — build SPA, serve via nginx
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
# знак приложения и манифест: без них сборка проходит, а в образе иконок нет —
# и браузер получает по адресу картинки оболочку приложения с кодом 200
COPY public ./public
RUN npm run build

FROM nginx:1.27-alpine AS runner
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
