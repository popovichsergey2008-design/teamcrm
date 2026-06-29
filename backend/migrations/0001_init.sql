-- TEAMCRM Этап 1 — DDL baseline (forward-only).
-- Конвенции: tenant_id везде; TIMESTAMPTZ в UTC; PK BIGINT IDENTITY; деньги NUMERIC(14,2).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

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
    password_hash  VARCHAR(255) NOT NULL,      -- argon2; никогда не возвращается API
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

-- Версионируемая ставка: себестоимость (Этап 2) считается по ставке,
-- действовавшей на момент интервала трекинга (effective_from/effective_to).
CREATE TABLE rates (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id),
    user_id        BIGINT NOT NULL REFERENCES users(id),
    hourly_rate    NUMERIC(14,2) NOT NULL,
    currency       CHAR(3) NOT NULL DEFAULT 'RUB',
    effective_from TIMESTAMPTZ NOT NULL,
    effective_to   TIMESTAMPTZ NULL,           -- NULL = действует сейчас
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rates_user_effective ON rates (tenant_id, user_id, effective_from);

CREATE TABLE deals (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id),
    client_id      BIGINT NULL REFERENCES clients(id),
    title          VARCHAR(255) NOT NULL,
    stage          VARCHAR(48) NOT NULL,          -- воронка
    amount         NUMERIC(14,2) NULL,            -- сумма сделки
    planned_margin NUMERIC(5,2) NULL,             -- плановая маржа, %
    project_id     BIGINT NULL,                   -- заполняется при развороте (фича №5)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- FK deals.project_id -> projects.id добавляется после создания projects.
ALTER TABLE deals
    ADD CONSTRAINT fk_deals_project FOREIGN KEY (project_id) REFERENCES projects(id);

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
    embedding   vector(1536) NOT NULL,          -- размерность под embeddings-модель
    model       VARCHAR(64) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (task_id)
);
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
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);
