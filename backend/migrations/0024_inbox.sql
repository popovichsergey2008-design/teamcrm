-- Авто-задачи из переписок: входящие сообщения (почта/мессенджер через вебхук) → черновик задачи (ревью).

-- Канал приёма: секретный token в URL вебхука; опциональный проект по умолчанию для черновиков.
CREATE TABLE inbox_sources (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id          BIGINT NOT NULL REFERENCES tenants(id),
    label              VARCHAR(120) NULL,
    token              VARCHAR(64) NOT NULL UNIQUE,
    default_project_id BIGINT NULL REFERENCES projects(id) ON DELETE SET NULL,
    created_by         BIGINT NULL REFERENCES users(id),
    is_active          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_inbox_sources_tenant ON inbox_sources (tenant_id);

-- Входящее сообщение + распознанный черновик задачи (human-in-the-loop: создаётся только после подтверждения).
CREATE TABLE inbox_items (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    source_id    BIGINT NOT NULL REFERENCES inbox_sources(id) ON DELETE CASCADE,
    sender       VARCHAR(320) NULL,
    subject      VARCHAR(500) NULL,
    body         TEXT NOT NULL,
    status       VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending|created|dismissed|ignored
    draft        JSONB NULL,                              -- предложенный черновик задачи
    task_id      BIGINT NULL,                             -- созданная задача (после подтверждения)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ NULL
);
CREATE INDEX idx_inbox_items_tenant ON inbox_items (tenant_id, status);
