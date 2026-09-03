-- Реакции и закрепления в мессенджере.
--
-- Реакция — способ ответить «понял», не засоряя переписку и не будя всех уведомлением.
-- В чате задачи они уже есть, и там видно, насколько это разгружает ленту: половина
-- сообщений «ок» и «спасибо» превращается в один знак.
CREATE TABLE chat_message_reactions (
    message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    emoji      VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- один человек — одна такая реакция на сообщение; повторное нажатие её снимает
    PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX idx_chat_reactions_msg ON chat_message_reactions (message_id);

-- Закрепление: то, что нужно всем и всегда под рукой.
--
-- Доступы к тестовому серверу, правила канала, ссылка на макет — это ищут прокруткой
-- на сотню сообщений назад. Закреплённое живёт в шапке чата и не теряется.
ALTER TABLE chat_messages ADD COLUMN pinned_at TIMESTAMPTZ NULL;
ALTER TABLE chat_messages ADD COLUMN pinned_by BIGINT NULL REFERENCES users(id);
CREATE INDEX idx_chat_messages_pinned ON chat_messages (chat_id, pinned_at DESC)
    WHERE pinned_at IS NOT NULL;
