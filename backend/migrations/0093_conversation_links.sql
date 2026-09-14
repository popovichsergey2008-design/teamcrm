-- Связи чата с сущностями CRM (ТЗ-5, этап 3, раздел 42).
--
-- Чат знает, к чему он относится: задача выросла из сообщения, в чат отправили
-- карточку проекта, разговор идёт вокруг мита. Раньше это лежало в трёх местах —
-- chats.project_id, chats.client_id, chat_messages.task_id, — и каждый новый вид
-- связи требовал новой колонки. Одна таблица на все виды:
--   entity_type   — task | project | client | meeting | deal
--   relation_type — source (чат заведён ПРИ сущности: чат проекта, чат клиента),
--                   created_from (задача создана из сообщения этого чата),
--                   shared (в чат отправили карточку сущности),
--                   related (связали вручную)
--
-- Старые колонки остаются: на них завязаны выборки и синхронизации. Здесь —
-- зеркало, которое читает сайдбар. Существующие связи переливаются ниже.
CREATE TABLE conversation_links (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    chat_id       BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    entity_type   VARCHAR(16) NOT NULL,
    entity_id     BIGINT NOT NULL,
    relation_type VARCHAR(16) NOT NULL DEFAULT 'related',
    created_by    BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (chat_id, entity_type, entity_id, relation_type)
);
CREATE INDEX idx_conversation_links_entity ON conversation_links (tenant_id, entity_type, entity_id);

INSERT INTO conversation_links (tenant_id, chat_id, entity_type, entity_id, relation_type)
SELECT tenant_id, id, 'project', project_id, 'source' FROM chats WHERE project_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO conversation_links (tenant_id, chat_id, entity_type, entity_id, relation_type)
SELECT tenant_id, id, 'client', client_id, 'source' FROM chats WHERE client_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO conversation_links (tenant_id, chat_id, entity_type, entity_id, relation_type, created_by, created_at)
SELECT m.tenant_id, m.chat_id, 'task', m.task_id, 'created_from', m.author_id, m.created_at
  FROM chat_messages m
  JOIN tasks t ON t.id = m.task_id
 WHERE m.task_id IS NOT NULL
ON CONFLICT DO NOTHING;
