-- Слой 4 ТЗ-3: каналы, избранное и чат с собой.

-- Канал — общая тема, а не переписка нескольких человек.
--
-- Группа заводится под разговор («Сергей, Глеб, Юрий»), канал — под тему, которая
-- переживёт состав участников: #разработка, #маркетинг, #баги. Разница в том, кто
-- туда попадает: в группу зовут, в публичный канал человек входит сам.
--
-- is_private стоит по умолчанию TRUE: все существующие группы приватны по смыслу,
-- и молча раскрывать их содержимое всей компании было бы утечкой.
ALTER TABLE chats ADD COLUMN is_private BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE chats ADD COLUMN description VARCHAR(300) NULL;

-- Витрина «Все каналы» ищет публичные каналы компании: под этот запрос индекс.
CREATE INDEX idx_chats_public ON chats (tenant_id, kind) WHERE is_private = FALSE;

-- Избранное: закреплённые сверху чаты.
--
-- В списке из сорока переписок нужные четыре ищут глазами каждый раз. Порядок личный:
-- у каждого свои четыре.
CREATE TABLE chat_favorites (
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id   BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, chat_id)
);
CREATE INDEX idx_chat_favorites_user ON chat_favorites (tenant_id, user_id);
