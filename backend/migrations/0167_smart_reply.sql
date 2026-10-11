-- ТЗ-21, этап 5: готовый ответ в чате.
--
-- Черновик живёт до нового сообщения в чате: ключ — последнее сообщение, на которое он
-- отвечает. Пришло новое — нужен новый черновик, старый просто перестаёт совпадать.
-- outcome — что человек сделал с черновиком: по этому видно, помогает ли навык.

CREATE TABLE IF NOT EXISTS smart_reply_drafts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id         BIGINT      NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    last_message_id BIGINT      NOT NULL,
    variant         SMALLINT    NOT NULL DEFAULT 0,
    reason          VARCHAR(24) NOT NULL,
    text            TEXT        NOT NULL,
    model           VARCHAR(80) NULL,
    -- accepted (взял как есть) | edited (взял и поправил) | dismissed (скрыл)
    outcome         VARCHAR(12) NULL,
    outcome_at      TIMESTAMPTZ NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, chat_id, last_message_id, variant)
);
CREATE INDEX IF NOT EXISTS idx_smart_reply_user_day ON smart_reply_drafts (user_id, created_at);
