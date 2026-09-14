-- AnthillBot — персональный AI-агент (ТЗ-6, этап 1 / MVP 1).
--
-- Сессии и сообщения агента наследуют «Корпоративный разум» (brain_*): это тот же
-- диалог с цитатами, только теперь с контекстом страницы, инструментами и
-- действиями. Историю переливаем — люди уже задавали вопросы, и терять их нельзя.
--
-- Действия — отдельной таблицей (разд. 62): модель НЕ меняет базу сама, она лишь
-- предлагает; строка здесь — предложение, подтверждение, результат и откат.
-- Имя ai_tool_actions, а не ai_actions: под ai_actions уже живёт журнал секретаря
-- (0041) — там считают сэкономленные минуты, здесь ждут нажатия «Создать».

CREATE TABLE ai_sessions (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id           BIGINT NOT NULL REFERENCES tenants(id),
    user_id             BIGINT NOT NULL REFERENCES users(id),
    title               VARCHAR(255) NULL,
    -- с чем открыли разговор: task | project | chat | meeting (разд. 60)
    context_entity_type VARCHAR(16) NULL,
    context_entity_id   BIGINT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_sessions_user ON ai_sessions (tenant_id, user_id, updated_at DESC);

CREATE TABLE ai_messages (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    session_id  BIGINT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
    role        VARCHAR(16) NOT NULL,              -- user | assistant
    content     TEXT NOT NULL,
    -- источники ответа: [{kind, id, title, url}] — только те, что отдали инструменты
    citations   JSONB NULL,
    -- какие инструменты вызывались и с чем: видно, откуда ответ
    tools       JSONB NULL,
    action_id   BIGINT NULL,
    model       VARCHAR(64) NULL,
    tokens      INT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_messages_session ON ai_messages (session_id, id);

CREATE TABLE ai_tool_actions (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         BIGINT NOT NULL REFERENCES tenants(id),
    session_id        BIGINT NULL REFERENCES ai_sessions(id) ON DELETE SET NULL,
    user_id           BIGINT NOT NULL REFERENCES users(id),
    tool              VARCHAR(48) NOT NULL,
    input_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_json       JSONB NULL,
    requires_approval BOOLEAN NOT NULL DEFAULT true,
    approved_at       TIMESTAMPTZ NULL,
    -- pending → done | rejected | failed | undone
    status            VARCHAR(16) NOT NULL DEFAULT 'pending',
    error             TEXT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_tool_actions_user ON ai_tool_actions (tenant_id, user_id, created_at DESC);

ALTER TABLE ai_messages
    ADD CONSTRAINT fk_ai_messages_action FOREIGN KEY (action_id) REFERENCES ai_tool_actions(id) ON DELETE SET NULL;

-- Оценка ответа (разд. 45): 👍/👎 и причина — сырьё для правки промптов и поиска.
CREATE TABLE ai_feedback (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    message_id BIGINT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id),
    vote       SMALLINT NOT NULL,                  -- 1 | -1
    reason     VARCHAR(32) NULL,                   -- inaccurate | not_found | invented | wrong_context | wording | other
    comment    VARCHAR(500) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, user_id)
);

-- История «Корпоративного разума» переезжает в сессии агента.
INSERT INTO ai_sessions (tenant_id, user_id, title, created_at, updated_at)
SELECT tenant_id, user_id, title, created_at, created_at FROM brain_conversations ORDER BY id;

INSERT INTO ai_messages (tenant_id, session_id, role, content, citations, created_at)
SELECT c.tenant_id, s.id, m.role, m.content, m.citations, m.created_at
  FROM brain_messages m
  JOIN brain_conversations c ON c.id = m.conversation_id
  JOIN ai_sessions s ON s.tenant_id = c.tenant_id AND s.user_id = c.user_id AND s.created_at = c.created_at
       AND s.title IS NOT DISTINCT FROM c.title
 ORDER BY m.id;
