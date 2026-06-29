> Часть каноничной спеки TEAMCRM. Master: [master.md](master.md).

# Этап 1 — Архитектура и гибридная data-структура

Этап 1 превращает контракты master-спеки в работающий каркас: гибридную БД (реляционный + векторный + кэш слои), ядро бэкенда с JWT/RBAC, realtime-слой на WebSocket, лёгкий SPA с канбан-доской и стабилизацию под нагрузкой.

Миссия: получить фундамент, на который без переделок ложится финансовое ядро Этапа 2 — пользователи входят по ролям, видят канбан-доску, переносят карточки в реальном времени, а база уже умеет хранить эмбеддинги.

Non-goals этапа (ТЗ выносит это в Этапы 2–5):

- никакого расчёта себестоимости и P&L (Этап 2);
- никакого тайм-трекера с кнопкой «В работу/Пауза» сверх схемы `time_log` (Этап 2);
- никаких ИИ-интеграций, Telegram-бота, Whisper, RAG (Этапы 3, 5);
- никакого клиентского портала и биллинга (Этап 5);
- эмбеддинги **хранятся и принимаются**, но конвейер их вычисления и семантический поиск — Этап 5.

## Структура репозитория

| Путь | Владелец | Содержимое |
|---|---|---|
| `/docker-compose.yml`, `/docker` | infra | сервисы из Этапа 0 + контейнеры backend/frontend |
| `/backend` | NestJS | API, домен, realtime, миграции |
| `/backend/src/modules` | NestJS | модули по доменам (auth, users, projects, tasks, deals, board, realtime) |
| `/backend/src/common` | NestJS | API-конверт, guards (JWT/RBAC), tenant-scope, фильтры ошибок |
| `/backend/migrations` | SQL/ORM | версионируемые миграции (только forward) |
| `/backend/test` | NestJS | unit/integration/e2e тесты |
| `/frontend` | React | SPA, дизайн-система, роутинг, стейт, канбан |
| `/frontend/src` | React | компоненты, страницы, API-клиент, socket-клиент |

Принцип: backend — единственный владелец доменной модели и записи в БД. Frontend обращается только к API и WebSocket.

## Шаг 1.1. Гибридная структура базы данных

PostgreSQL — durable source of truth. Реляционный слой хранит бизнес-данные; векторный слой (pgvector, HNSW-индексы) — эмбеддинги; Redis кэширует аналитику поверх обоих. ACID PostgreSQL необходим для будущего финучёта.

### DDL baseline

Конвенции:

- все таблицы — `tenant_id BIGINT NOT NULL` (корень изоляции), кроме самой `tenants`;
- временные метки — `TIMESTAMPTZ` в UTC;
- первичные ключи — `BIGINT GENERATED ALWAYS AS IDENTITY` (или UUID — выбор фиксируется реализацией единообразно);
- денежные значения — `NUMERIC(14,2)`, никогда float;
- миграции только forward; откат — встречной миграцией.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE tenants (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(160) NOT NULL,
    data_region VARCHAR(32)  NOT NULL,        -- ru | eu (data-residency из Этапа 0)
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE roles (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        VARCHAR(32) NOT NULL,          -- owner | manager | member | client
    description VARCHAR(255) NULL,
    UNIQUE (code)
);

CREATE TABLE users (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id),
    email          VARCHAR(255) NOT NULL,
    password_hash  VARCHAR(255) NOT NULL,      -- argon2/bcrypt; никогда не возвращается API
    full_name      VARCHAR(160) NOT NULL,
    role_id        BIGINT NOT NULL REFERENCES roles(id),
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

CREATE TABLE clients (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    name        VARCHAR(160) NOT NULL,
    contact     VARCHAR(255) NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Версионируемая ставка: себестоимость на Этапе 2 считается по ставке,
-- действовавшей на момент интервала трекинга (effective_from/effective_to).
CREATE TABLE rates (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id),
    user_id        BIGINT NOT NULL REFERENCES users(id),
    hourly_rate    NUMERIC(14,2) NOT NULL,
    currency       CHAR(3) NOT NULL DEFAULT 'RUB',
    effective_from TIMESTAMPTZ NOT NULL,
    effective_to   TIMESTAMPTZ NULL,           -- NULL = действует сейчас
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    KEY_PLACEHOLDER BOOLEAN
);
CREATE INDEX idx_rates_user_effective ON rates (tenant_id, user_id, effective_from);

CREATE TABLE deals (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    client_id    BIGINT NULL REFERENCES clients(id),
    title        VARCHAR(255) NOT NULL,
    stage        VARCHAR(48) NOT NULL,          -- воронка
    amount       NUMERIC(14,2) NULL,            -- сумма сделки
    planned_margin NUMERIC(5,2) NULL,           -- плановая маржа, %
    project_id   BIGINT NULL,                   -- заполняется при развороте (фича №5)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    client_id    BIGINT NULL REFERENCES clients(id),
    deal_id      BIGINT NULL REFERENCES deals(id),  -- источник, если развёрнут из сделки
    name         VARCHAR(255) NOT NULL,
    budget       NUMERIC(14,2) NULL,
    status       VARCHAR(48) NOT NULL DEFAULT 'active',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE board_columns (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    project_id  BIGINT NOT NULL REFERENCES projects(id),
    name        VARCHAR(96) NOT NULL,
    position    INT NOT NULL,                   -- порядок колонок
    UNIQUE (project_id, position)
);

CREATE TABLE tasks (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    project_id    BIGINT NOT NULL REFERENCES projects(id),
    column_id     BIGINT NOT NULL REFERENCES board_columns(id),
    position      INT NOT NULL,                 -- порядок внутри колонки (drag-and-drop)
    title         VARCHAR(255) NOT NULL,
    description   TEXT NULL,
    assignee_id   BIGINT NULL REFERENCES users(id),
    status        VARCHAR(48) NOT NULL,         -- производное от колонки; DONE и т.п.
    is_blocked    BOOLEAN NOT NULL DEFAULT FALSE, -- красный тег BLOCKED (Этап 3)
    cost_current  NUMERIC(14,2) NOT NULL DEFAULT 0, -- денормализованная себестоимость (Этап 2)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at     TIMESTAMPTZ NULL              -- при закрытии → очередь на эмбеддинг
);
CREATE INDEX idx_tasks_board ON tasks (tenant_id, project_id, column_id, position);
CREATE INDEX idx_tasks_assignee ON tasks (tenant_id, assignee_id, status);

-- Трекинг фиксируется фактом (кнопка «В работу/Пауза», Этап 2).
-- На Этапе 1 таблица создаётся; активная запись из UI — Этап 2.
CREATE TABLE time_logs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
    task_id         BIGINT NOT NULL REFERENCES tasks(id),
    user_id         BIGINT NOT NULL REFERENCES users(id),
    timestamp_start TIMESTAMPTZ NOT NULL,
    timestamp_end   TIMESTAMPTZ NULL,           -- NULL = идёт сейчас
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_time_logs_task ON time_logs (tenant_id, task_id);
CREATE INDEX idx_time_logs_user ON time_logs (tenant_id, user_id, timestamp_start);

-- Векторный слой: эмбеддинг закрытой задачи. Принимается с Этапа 1,
-- вычисление и семантический поиск — Этап 5 (граф знаний).
CREATE TABLE task_embeddings (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    embedding   vector(1536) NOT NULL,          -- размерность под выбранную embeddings-модель
    model       VARCHAR(64) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (task_id)
);
-- HNSW-индекс для семантического поиска (используется на Этапе 5).
CREATE INDEX idx_task_embeddings_hnsw ON task_embeddings
    USING hnsw (embedding vector_cosine_ops);

CREATE TABLE refresh_tokens (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id),
    token_hash  VARCHAR(255) NOT NULL,          -- хранится только хэш
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE schema_migrations (
    version     VARCHAR(64) PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

> Поле `KEY_PLACEHOLDER` в `rates` — артефакт-заглушка, при реализации убрать; оставлено только чтобы подчеркнуть: версионность ставки (`effective_from/effective_to`) — обязательный контракт для Этапа 2, а не опциональное удобство.

Контракты схемы:

- **tenant scope везде.** Каждая бизнес-таблица имеет `tenant_id`; репозитории фильтруют по tenant из JWT. Кросс-tenant выборка невозможна.
- **Эмбеддинги с первого дня.** Таблица `task_embeddings` и HNSW-индекс создаются на Этапе 1, чтобы Этап 5 строился по накопленной базе. ТЗ: без этого граф знаний по старой базе будет невозможен.
- **Версионные ставки.** `rates` хранит историю — себестоимость на Этапе 2 считается по ставке на момент трекинга.
- **Денежные поля под будущий финучёт** уже в схеме (`tasks.cost_current`, `projects.budget`, `deals.amount`), но заполняются/считаются только с Этапа 2.

**DoD шага:** схема развёрнута миграциями; миграции версионируются; векторный слой готов принимать эмбеддинги; кэш-ключи аналитики в Redis спроектированы (даже если значения появятся на Этапе 2).

## Шаг 1.2. Ядро бэкенда и realtime-слой

Каркас приложения на **NestJS** (TypeScript), модульная структура. JWT-аутентификация (access + refresh) и ролевая модель (RBAC). WebSocket-сервер (Socket.io) с комнатами по проектам и авторизацией сокетов.

### Модули NestJS

| Модуль | Владеет |
|---|---|
| `AuthModule` | регистрация/вход, JWT (access+refresh), хэш паролей, refresh-ротация |
| `UsersModule` | пользователи, роли, профиль |
| `TenantsModule` | арендаторы; tenant-scope middleware/guard |
| `ProjectsModule` | проекты, колонки доски |
| `TasksModule` | задачи, перемещение/обновление, CRUD |
| `DealsModule` | сделки воронки; разворот сделки в проект (фича №5) |
| `BoardModule` | агрегирующее чтение доски (колонки + задачи) |
| `RealtimeModule` | WebSocket Gateway, комнаты, эмиссия доменных событий |
| `CommonModule` | API-конверт, guards (JWT, RBAC, tenant), фильтр ошибок, валидация |

### Контракт авторизации

- браузер использует JWT access-токен в заголовке `Authorization: Bearer`; refresh — для ротации;
- каждый мутирующий запрос проходит `JwtAuthGuard` → `TenantGuard` (scope) → `RolesGuard` (RBAC);
- `tenant_id` и `role` берутся из токена; запрос не может подменить tenant;
- секреты, хэши паролей и refresh-токены никогда не возвращаются API;
- пароли хэшируются argon2/bcrypt; refresh-токены хранятся только хэшем (`refresh_tokens.token_hash`).

### Realtime-контракт

- сокет авторизуется тем же JWT при handshake; неавторизованный сокет отклоняется;
- комнаты — `project:{tenant_id}:{project_id}`; пользователь подключается только к доступным проектам;
- **клиентская роль получает client-представление**: события с финансовыми полями не публикуются в клиентские комнаты (на Этапе 1 финансов ещё нет, но изоляция комнат и фильтрация полей закладываются здесь);
- горизонтальное масштабирование — Redis-адаптер Socket.io; presence в Redis;
- WebSocket — только транспорт уведомлений. Запись всегда через REST/command path, затем эмиссия события.

Доменные события Этапа 1: `task.moved`, `task.updated`, `task.created`, `deal.converted`, `column.updated`.

**DoD шага:** API-скелет с авторизацией и разграничением ролей; realtime-канал работает между клиентами; перенос карточки виден у всех участников проекта мгновенно.

## Шаг 1.3. Лёгкий SPA-интерфейс

Фронтенд на **React** (TypeScript) с собственной дизайн-системой. Минималистичный, чистый интерфейс — главное визуальное отличие от перегруженного Битрикс24 (ТЗ).

Состав:

- дизайн-система (токены, базовые компоненты), роутинг, стейт-менеджмент;
- экран входа (JWT-логин, хранение/ротация токена);
- модуль канбан-доски: колонки, карточки, drag-and-drop, CRUD задач;
- подключение realtime: оптимистичные обновления + синхронизация изменений между пользователями (перенос карточки виден у всех мгновенно).

Контракты UI:

- SPA обращается только к API и WebSocket; не имеет прямого доступа к БД, Redis, RabbitMQ, LLM;
- доменная модель и правила — на бэкенде; фронт не реализует бизнес-логику расчётов;
- единый API-клиент с обработкой конверта `ok`/`error`; единый socket-клиент с реконнектом;
- UI никогда не показывает секреты.

**DoD шага:** лёгкий SPA-каркас с авторизацией; доска с задачами работает на одном клиенте; перенос карточки синхронизируется между клиентами в реальном времени.

## Шаг 1.4. Стабилизация и нагрузочная проверка

- интеграционные тесты (с реальными PostgreSQL/Redis/RabbitMQ через Docker);
- нагрузочное тестирование realtime-слоя (k6 / Artillery): множество одновременных сокетов и перемещений карточек;
- документация API (Swagger/OpenAPI), генерируемая из контроллеров;
- фикс багов и формальная приёмка этапа по Definition of Done.

Аргументация (ТЗ): realtime-слой проверяется под нагрузкой именно сейчас — на Этапе 2 добавятся финансовые расчёты, и искать узкие места в WebSocket под боевым трафиком будет уже дорого.

**DoD шага:** этап принят по Definition of Done; есть нагрузочный артефакт по realtime-слою.

---

## API-контракт Этапа 1

Все ответы — в конверте `ok`/`error` (см. master → API envelope). Минимальные эндпоинты:

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/api/health` | health: БД, Redis, RabbitMQ, версия схемы |
| `POST` | `/api/auth/register` | регистрация (в рамках tenant) |
| `POST` | `/api/auth/login` | вход, выдача access+refresh |
| `POST` | `/api/auth/refresh` | ротация токена |
| `POST` | `/api/auth/logout` | отзыв refresh-токена |
| `GET` | `/api/me` | профиль текущего пользователя и роль |
| `GET` | `/api/projects` | список проектов tenant |
| `POST` | `/api/projects` | создать проект |
| `GET` | `/api/projects/{id}/board` | доска: колонки + задачи |
| `POST` | `/api/tasks` | создать задачу |
| `PATCH` | `/api/tasks/{id}` | обновить задачу |
| `POST` | `/api/tasks/{id}/move` | перенос задачи (колонка + позиция) → эмитит `task.moved` |
| `GET` | `/api/deals` | список сделок воронки |
| `POST` | `/api/deals` | создать сделку |
| `POST` | `/api/deals/{id}/convert` | развернуть сделку в проект (фича №5) → эмитит `deal.converted` |

Эндпоинты с финансовыми полущениями (себестоимость, P&L) **не входят в Этап 1** — добавляются на Этапе 2. Поля `cost_current`/`budget` присутствуют в схеме, но в client-представлении не отдаются и на Этапе 1 равны 0/плановым значениям.

## Серверная верификация Этапа 1

Обязательные проверки (на staging, в Docker-окружении из Этапа 0):

```bash
# backend
npm ci
npm run lint
npm run test            # unit
npm run test:integration  # с реальными PG/Redis/RabbitMQ
npm run test:e2e
npm run build

# frontend
npm ci
npm run lint
npm run build
```

Минимальные группы тестов:

| Группа | Минимальные кейсы |
|---|---|
| auth/RBAC | вход/refresh/logout; доступ запрещён без токена; роль не даёт лишних прав |
| tenant-изоляция | пользователь tenant A не видит/не меняет данные tenant B |
| board CRUD | создание/обновление/перенос задачи; корректный порядок позиций |
| realtime | `task.moved` доходит до всех участников проекта; чужой проект событий не получает |
| client-изоляция | роль `client` не получает финансовые поля ни в REST, ни в WebSocket-комнате |
| deal→project | разворот сделки создаёт проект и связывает `deal.project_id` |
| миграции | схема применяется с нуля; pgvector-расширение и HNSW-индекс создаются |
| нагрузка (smoke) | артефакт по числу одновременных сокетов и перемещений в realtime-слое |

Артефакты после верификации: список команд и коды выхода; вывод тестов backend/frontend; список применённых миграций; нагрузочный артефакт realtime; commit SHA, задеплоенный на staging.

Этап 1 принимается только при прохождении всех security- и tenant-изоляционных тестов до нагрузочного smoke. Нагрузочное число без проходящих security-тестов приёмочным артефактом не является.

## Контрольная точка этапа

По завершении Этапа 1 существует работающий каркас: пользователи входят по ролям, видят канбан-доску и переносят карточки в реальном времени, а база уже умеет хранить эмбеддинги. Это фундамент, на который без переделок ложится финансовое ядро Этапа 2.
