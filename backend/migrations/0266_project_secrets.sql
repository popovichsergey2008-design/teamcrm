-- #4902, п. 13: пароли и ключи — не в переписке, а в «Секретах» проекта.
--
-- 13.11 в общем чате нашли логин и пароль от dev-сайта: их видели все, они уходили в
-- поиск, сводки и протоколы. Теперь секрет из сообщения переносится сюда, а в
-- сообщении остаётся метка «🔒 в Секретах проекта».
--
-- Значение — только зашифрованным (тот же AES-256-GCM, что у ключей интеграций):
-- выгрузка базы или бэкап не должны раскрывать пароли. Расшифровывает сервер и только
-- для тех, кто в проекте (владелец, руководитель, участники проекта).
CREATE TABLE IF NOT EXISTS project_secrets (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         BIGINT NOT NULL REFERENCES tenants(id),
    project_id        BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title             VARCHAR(160) NOT NULL,
    -- password | token | card | cvv | private_key | connection — как распознал детектор
    kind              VARCHAR(16) NOT NULL DEFAULT 'password',
    value_enc         TEXT NOT NULL,
    -- откуда перенесли: по метке в сообщении секрет находится обратно
    source_message_id BIGINT NULL REFERENCES chat_messages(id) ON DELETE SET NULL,
    created_by        BIGINT NULL REFERENCES users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_project_secrets_project ON project_secrets (tenant_id, project_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_project_secrets_message ON project_secrets (source_message_id) WHERE source_message_id IS NOT NULL;
