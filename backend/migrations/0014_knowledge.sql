-- Этап 5, K1 — RAG-база знаний: обобщённый векторный индекс + регламенты + метеринг ИИ.

-- Обобщённый индекс знаний (источники: task | comment | regulation).
CREATE TABLE knowledge_chunks (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    source_type  VARCHAR(24) NOT NULL,            -- task | comment | regulation
    source_id    BIGINT NOT NULL,
    chunk_index  INT NOT NULL,
    access_scope BIGINT NULL,                     -- обычно project_id; фильтр доступа
    title        VARCHAR(255) NULL,               -- заголовок источника (для цитат)
    content      TEXT NOT NULL,                   -- маскированный текст чанка
    content_hash VARCHAR(64) NOT NULL,            -- хеш ВСЕГО источника — идемпотентность
    embedding    vector(1536) NOT NULL,
    model        VARCHAR(64) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, source_type, source_id, chunk_index)
);
CREATE INDEX idx_knowledge_hnsw ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_knowledge_scope ON knowledge_chunks (tenant_id, source_type, access_scope);
CREATE INDEX idx_knowledge_source ON knowledge_chunks (tenant_id, source_type, source_id);

-- Регламенты (внутренние документы) — источник знаний.
CREATE TABLE regulations (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    title       VARCHAR(255) NOT NULL,
    body        TEXT NOT NULL,
    created_by  BIGINT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_regulations_tenant ON regulations (tenant_id, updated_at);

-- Durable метеринг ИИ-расхода (эмбеддинги, Brain, standup, copilot).
CREATE TABLE ai_usage (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    feature       VARCHAR(32) NOT NULL,           -- embedding | brain | standup_parse | copilot
    model         VARCHAR(64) NOT NULL,
    input_tokens  INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    cache_hit     BOOLEAN NOT NULL DEFAULT FALSE,
    cost_estimate NUMERIC(12,4) NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_usage_tenant ON ai_usage (tenant_id, created_at);
