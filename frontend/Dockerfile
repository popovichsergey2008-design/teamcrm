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

# Сжатые копии кладём РЯДОМ с файлами, а не жмём на каждый запрос.
#
# nginx отдавал сборку как есть: главный кусок кода весил 1,36 МБ вместо 341 КБ, а
# набор эмодзи — 705 КБ вместо 160. На каждом открытии страницы это лишняя секунда,
# и на телефоне по мобильной сети она заметна больше всего. Имя файла со сборкой
# меняется при каждой выкладке и кэшируется навсегда, поэтому сжать один раз при
# сборке образа дешевле и плотнее (уровень 9), чем жать одно и то же на лету.
# `gzip -c` вместо `gzip -k`: ключ «оставить исходник» есть не во всех сборках busybox,
# а перенаправление вывода работает везде.
RUN find /usr/share/nginx/html -type f \
      \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.json' -o -name '*.map' \) \
      -size +1k -exec sh -c 'for f; do gzip -9 -c "$f" > "$f.gz"; done' _ {} +
EXPOSE 80
