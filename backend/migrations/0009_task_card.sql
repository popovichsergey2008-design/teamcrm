-- TEAMCRM Enhancements v1, Этап D — карточка задачи (Bitrix-класс).

ALTER TABLE tasks
    ADD COLUMN priority VARCHAR(8) NOT NULL DEFAULT 'normal';  -- low|normal|high|urgent

CREATE TABLE task_comments (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    author_id   BIGINT NOT NULL REFERENCES users(id),
    body        TEXT NOT NULL,
    is_client_visible BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at   TIMESTAMPTZ NULL
);
CREATE INDEX idx_task_comments_task ON task_comments (tenant_id, task_id, created_at);

CREATE TABLE task_attachments (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    file_id     BIGINT NOT NULL REFERENCES files(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (task_id, file_id)
);
CREATE INDEX idx_task_attachments_task ON task_attachments (tenant_id, task_id);

CREATE TABLE task_checklist_items (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    text        VARCHAR(500) NOT NULL,
    is_done     BOOLEAN NOT NULL DEFAULT FALSE,
    position    INT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_checklist_task ON task_checklist_items (tenant_id, task_id, position);

CREATE TABLE labels (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    name        VARCHAR(48) NOT NULL,
    color       VARCHAR(16) NOT NULL DEFAULT '#5b8cff',
    UNIQUE (tenant_id, name)
);
CREATE TABLE task_labels (
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    label_id    BIGINT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
);

CREATE TABLE task_watchers (
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    PRIMARY KEY (task_id, user_id)
);

CREATE TABLE task_activity (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    actor_id    BIGINT NULL REFERENCES users(id),
    kind        VARCHAR(32) NOT NULL,
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_task_activity_task ON task_activity (tenant_id, task_id, created_at);
