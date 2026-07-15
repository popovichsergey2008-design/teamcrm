-- Google Docs/Sheets, на которые ссылаются задачи/комментарии.
-- Вытянутый текст индексируется в базу знаний (RAG, source_type='gdoc'), привязка к проекту задачи.
CREATE TABLE google_docs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,  -- разрез знаний по проекту
    doc_key       VARCHAR(128) NOT NULL,          -- id файла в Google
    doc_type      VARCHAR(24)  NOT NULL,          -- document | spreadsheet | presentation | file
    url           TEXT NOT NULL,
    title         VARCHAR(500) NULL,
    text          TEXT NULL,                      -- вытянутый текст (для переиндексации без повторного fetch)
    status        VARCHAR(24)  NOT NULL DEFAULT 'pending', -- pending|indexed|no_access|unsupported|error
    error         TEXT NULL,
    content_hash  VARCHAR(64)  NULL,
    fetched_at    TIMESTAMPTZ  NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, doc_key, project_id)       -- один док на проект (ссылки из разных задач дедуплицируются)
);
CREATE INDEX idx_google_docs_tenant ON google_docs (tenant_id, status);
