-- TEAMCRM Enhancements v1, Этап E — импорт задач из Битрикс24 (односторонний, вебхук).

-- Подключение интеграции. НЕСКОЛЬКО порталов на одну организацию.
CREATE TABLE integration_connections (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    provider      VARCHAR(24) NOT NULL,            -- 'bitrix'
    label         VARCHAR(120) NULL,               -- название подключения от клиента
    portal        VARCHAR(255) NULL,               -- домен портала (для отображения)
    webhook_enc   TEXT NOT NULL,                   -- зашифрованный URL вебхука (секрет)
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_by    BIGINT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_int_conn_tenant ON integration_connections (tenant_id, provider);

-- Карта соответствий внешних объектов локальным — привязка к КОНКРЕТНОМУ подключению
-- (ID у разных порталов совпадают), идемпотентность повторного импорта.
CREATE TABLE external_refs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    connection_id BIGINT NOT NULL REFERENCES integration_connections(id),
    entity_type   VARCHAR(24) NOT NULL,            -- project|column|task|user|comment|message
    external_id   VARCHAR(64) NOT NULL,
    local_id      BIGINT NOT NULL,
    external_hash VARCHAR(64) NULL,                -- хеш полей — пропускать неизменённое
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (connection_id, entity_type, external_id)
);
CREATE INDEX idx_external_refs_local ON external_refs (connection_id, entity_type, local_id);

-- Происхождение проекта: свой или импортированный (из какого подключения).
ALTER TABLE projects ADD COLUMN origin VARCHAR(24) NOT NULL DEFAULT 'local'; -- local|bitrix
ALTER TABLE projects ADD COLUMN origin_connection_id BIGINT NULL REFERENCES integration_connections(id);
CREATE INDEX idx_projects_origin ON projects (tenant_id, origin);

-- Архив сообщений уровня проекта (лента группы). Чата ещё нет — храним read-only.
CREATE TABLE imported_messages (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id),
    connection_id  BIGINT NOT NULL REFERENCES integration_connections(id),
    project_id     BIGINT NOT NULL REFERENCES projects(id),
    external_id    VARCHAR(64) NULL,
    author_user_id BIGINT NULL REFERENCES users(id),
    author_label   VARCHAR(160) NULL,
    body           TEXT NOT NULL,
    posted_at      TIMESTAMPTZ NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_imported_messages_project ON imported_messages (tenant_id, project_id, posted_at);

-- Журнал запусков импорта (прогресс/итоги) — по конкретному подключению.
CREATE TABLE import_runs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    connection_id BIGINT NOT NULL REFERENCES integration_connections(id),
    status        VARCHAR(16) NOT NULL DEFAULT 'queued', -- queued|running|done|error
    scope         JSONB NULL,
    stats         JSONB NULL,
    error         TEXT NULL,
    started_at    TIMESTAMPTZ NULL,
    finished_at   TIMESTAMPTZ NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_import_runs_conn ON import_runs (tenant_id, connection_id, created_at);
