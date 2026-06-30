# Enhancements v1 — Этап A. Файловое хранилище (MinIO + модуль `files`)

> Часть [трека улучшений](enh-00-master.md). Фундамент для аватаров (кабинет) и вложений в задачах. Реализуется первым.

## Цель

Единый, безопасный слой хранения бинарных файлов: загрузка, скачивание, удаление — с контролем доступа по tenant и по сущности-владельцу. Хранилище — **MinIO** (S3-совместимое), отдельный контейнер в стеке. Backend — единственный владелец доступа к bucket; клиент никогда не ходит в MinIO напрямую с боевыми ключами.

## Структура репозитория (добавления)

| Путь | Содержимое |
|---|---|
| `/backend/src/modules/files` | модуль файлов: контроллер upload/download, сервис, репозиторий метаданных, S3-клиент |
| `/infra/docker-compose.yml` | сервис `crm-minio` (внутренняя сеть, том данных) |

## Инфраструктура (Этап 0-стиль)

- Контейнер `crm-minio` (образ `minio/minio`) в `crm-net`; данные — в docker-volume; консоль/арт — **только на WireGuard-адрес `10.8.0.1`** (как остальные админ-сервисы), наружу не публикуется.
- Backend ходит в MinIO по внутренней сети (`crm-minio:9000`); креды (`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, bucket) — в `/opt/teamcrm/.env`, вне git.
- Bucket `teamcrm` создаётся при старте (init-контейнер `mc` или код backend при bootstrap).
- В CI MinIO добавляется сервис-контейнером (как pg/redis/rabbitmq) для integration/e2e.

## Доменная модель (DDL — миграция `0006`)

```sql
-- Метаданные файлов (бинарь — в MinIO; здесь только ссылка + контроль доступа).
CREATE TABLE files (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    object_key    VARCHAR(255) NOT NULL,           -- ключ в MinIO (tenant/<uuid>/<name>)
    file_name     VARCHAR(255) NOT NULL,
    content_type  VARCHAR(127) NOT NULL,
    size_bytes    BIGINT NOT NULL,
    owner_kind    VARCHAR(24) NOT NULL,            -- avatar | task_attachment
    owner_id      BIGINT NULL,                     -- task_id для вложений; NULL для аватара (см. users.avatar_file_id)
    uploaded_by   BIGINT NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, object_key)
);
CREATE INDEX idx_files_owner ON files (tenant_id, owner_kind, owner_id);
```

> Привязка к конкретным сущностям (аватар пользователя, вложение задачи) делается со стороны этих сущностей в своих этапах (поле `users.avatar_file_id`, таблица вложений ссылается на `files.id`).

## Контракт загрузки/скачивания

- **Загрузка**: `POST /api/files` (multipart) → валидация (тип из whitelist, размер ≤ лимита, напр. 25 МБ) → стрим в MinIO под ключ `tenant/<uuid>/<safeName>` → запись `files`. Возвращает `{id, fileName, contentType, sizeBytes}`.
- **Скачивание**: `GET /api/files/{id}` → проверка доступа (tenant + право видеть владельца) → отдача через backend-прокси-стрим **или** редирект на presigned-URL с коротким TTL. Прямой публичный доступ к bucket запрещён.
- **Удаление**: `DELETE /api/files/{id}` → автор/менеджер → удаляет объект в MinIO + строку.
- **Access-control**: файл доступен только в рамках своего tenant; для `task_attachment` — пользователю с доступом к проекту задачи; роль `client` — только если сущность помечена client-видимой (на будущее).
- **Безопасность**: имя файла санитизируется; content-type не доверяется слепо (проверка по сигнатуре опционально); защита от path traversal в object_key; лимиты размера/типа конфигурируемы.

## API

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/api/files` | загрузка (multipart); тело: file + `ownerKind` (+`ownerId`) |
| `GET` | `/api/files/{id}` | скачивание/просмотр (access-controlled) |
| `DELETE` | `/api/files/{id}` | удаление (автор/manager/owner) |

## Доступ к файлам с клиента (фикс 2026-06-30)

`GET /api/files/{id}` защищён `JwtAuthGuard` — требует заголовок `Authorization: Bearer`. Поэтому **прямые ссылки в браузере недопустимы**: `<img src="/api/files/:id">`, `<a href="/api/files/:id">` и открытие URL в новой вкладке уходят БЕЗ токена → `401 Missing bearer token` (битая картинка / ошибка вместо файла).

**Правило фронтенда:** любой защищённый файл загружается авторизованным `fetch` (Bearer) как Blob, далее показывается через `object-URL`:
- `api.authedBlob(path)` → `Blob`; `api.authedObjectUrl(path)` → `URL.createObjectURL(blob)`.
- **Аватары** — компонент `Avatar` (тянет blob по `users.avatar_file_id`), используется в шапке и кабинете.
- **Вложения задач** — клик по файлу: картинка (`blob.type` начинается с `image/`) открывается в **попапе-лайтбоксе** (`Lightbox`), прочее — скачивается через временный `<a download>`; object-URL освобождается (`revokeObjectURL`).
- Альтернатива на будущее (если понадобятся прямые ссылки/CDN): отдавать **presigned-URL** с коротким TTL вместо прокси-стрима.

## Этапы работ

- **A.1.** Инфраструктура: `crm-minio` в compose (+том, +bind на VPN), bucket-инициализация, env, CI сервис-контейнер.
- **A.2.** Модуль `files`: S3-клиент (aws-sdk v3 или minio SDK), миграция `0006`, репозиторий, сервис (upload/stream/delete), валидация типов/размера.
- **A.3.** Контроллер + access-control + Swagger; интеграция с RBAC/tenant-guard.
- **A.4.** Тесты: unit (валидация/санитизация), integration (реальный MinIO: upload→download→delete), security (чужой tenant не качает файл).

## DoD этапа A

Файл загружается в MinIO и скачивается через backend только владельцем tenant; типы/размер валидируются; прямой доступ к bucket закрыт; integration-тест upload→download→delete зелёный; MinIO поднят в стеке и в CI.

## Тесты (минимум)

| Группа | Кейсы |
|---|---|
| валидация | отклонение неразрешённого типа/превышения размера; санитизация имени |
| хранение | upload кладёт объект в MinIO; download возвращает тот же байт-в-байт; delete удаляет объект и метаданные |
| изоляция | пользователь tenant B не может скачать/удалить файл tenant A (404/403) |
