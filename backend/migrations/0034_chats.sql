-- Этап 6, М1 — мессенджер команды: личные диалоги, группы и чаты проектов.
-- Заказчик (роль client) в командные чаты не допускается — у него свой портал.

CREATE TABLE chats (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
    kind            VARCHAR(16) NOT NULL,               -- dm | group | project
    title           VARCHAR(160) NULL,                  -- для group; у dm имя берётся от собеседника
    project_id      BIGINT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- пара участников диалога в порядке возрастания id: не даёт завести второй диалог
    -- между теми же людьми, если оба одновременно нажмут «Написать»
    dm_key          VARCHAR(64) NULL,
    created_by      BIGINT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX uq_chats_dm ON chats (tenant_id, dm_key) WHERE dm_key IS NOT NULL;
CREATE UNIQUE INDEX uq_chats_project ON chats (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_chats_tenant ON chats (tenant_id, last_message_at DESC NULLS LAST);

-- Участие и состояние прочтения. Для чатов проектов строка появляется лениво,
-- при первом открытии: доступ к проектному чату есть у всей команды и без неё.
CREATE TABLE chat_members (
    chat_id      BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    last_read_at TIMESTAMPTZ NULL,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX idx_chat_members_user ON chat_members (tenant_id, user_id);

CREATE TABLE chat_messages (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    chat_id    BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    author_id  BIGINT NULL REFERENCES users(id),
    body       TEXT NOT NULL DEFAULT '',
    file_id    BIGINT NULL REFERENCES files(id),   -- вложение сообщения (одно)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at  TIMESTAMPTZ NULL,
    deleted_at TIMESTAMPTZ NULL
);
-- лента чата читается с конца: индекс под «последние N сообщений»
CREATE INDEX idx_chat_messages_feed ON chat_messages (chat_id, id DESC);
