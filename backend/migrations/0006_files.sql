-- TEAMCRM Enhancements v1, Этап A — метаданные файлов (бинарь в MinIO).

CREATE TABLE files (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    object_key    VARCHAR(255) NOT NULL,           -- ключ в MinIO: tenant/<uuid>/<safeName>
    file_name     VARCHAR(255) NOT NULL,
    content_type  VARCHAR(127) NOT NULL,
    size_bytes    BIGINT NOT NULL,
    owner_kind    VARCHAR(24) NOT NULL,            -- avatar | task_attachment | generic
    owner_id      BIGINT NULL,
    uploaded_by   BIGINT NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, object_key)
);
CREATE INDEX idx_files_owner ON files (tenant_id, owner_kind, owner_id);
