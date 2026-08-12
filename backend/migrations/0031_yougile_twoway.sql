-- YouGile E4 — двусторонняя синхронизация (CRM → YouGile).
-- Выгрузка идёт через durable-очередь: изменение в CRM пишет строку в outbox,
-- фоновый воркер отправляет её в YouGile с ретраями (перезапуск приложения не теряет правки).

-- Выгрузка включается отдельно на каждом подключении (по умолчанию выключена —
-- существующие подключения остаются односторонними, пока владелец не включит).
ALTER TABLE integration_connections ADD COLUMN push_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE integration_outbox (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
    connection_id   BIGINT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
    -- task.create|task.update|task.move|comment.create|attachment.create
    -- |column.create|column.rename|column.delete|project.rename
    kind            VARCHAR(32) NOT NULL,
    local_id        BIGINT NOT NULL,                        -- id локального объекта (задача/коммент/колонка/проект)
    payload         JSONB NULL,                             -- доп. контекст (например taskId для коммента)
    status          VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending|sending|done|error
    attempts        INT NOT NULL DEFAULT 0,
    last_error      TEXT NULL,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- выборка воркером: только ждущие отправки, в порядке появления (порядок правок важен)
CREATE INDEX idx_outbox_pending ON integration_outbox (status, next_attempt_at, id);
CREATE INDEX idx_outbox_conn ON integration_outbox (connection_id, created_at DESC);
