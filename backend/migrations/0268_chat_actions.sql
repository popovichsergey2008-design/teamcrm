-- #4902, п. 7: «Поручения в сообщении → задачи одной кнопкой».
-- Одна карточка на сообщение: найденные поручения (кому, что, срок), проект и что уже
-- создано. Разбор делается один раз на сообщение (модель не зовётся на каждый показ),
-- номера созданных задач запоминаются у пунктов — повтор нажатия дублей не создаст.
-- Похожие задачи здесь НЕ хранятся: они считаются для каждого смотрящего с учётом
-- видимости проектов.

CREATE TABLE IF NOT EXISTS chat_assignment_cards (
    message_id       BIGINT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
    tenant_id        BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    chat_id          BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    -- [{key, title, assigneeId, assigneeHint, deadline, quote, taskId?, linkTaskId?, skip?}]
    items            JSONB NOT NULL DEFAULT '[]'::jsonb,
    project_id       BIGINT NULL REFERENCES projects(id) ON DELETE SET NULL,
    -- насколько уверен определитель проекта: HIGH | MEDIUM | LOW | NONE
    project_level    VARCHAR(8) NOT NULL DEFAULT 'NONE',
    -- кто разобрал: rules | model
    source           VARCHAR(8) NOT NULL DEFAULT 'rules',
    -- open → creating → created (или обратно в open, если часть не создалась)
    status           VARCHAR(12) NOT NULL DEFAULT 'open',
    claimed_at       TIMESTAMPTZ NULL,
    created_task_ids BIGINT[] NOT NULL DEFAULT '{}',
    -- «Не задачи»: карточка пропадает у нажавшего, у остальных остаётся
    dismissed_by     BIGINT[] NOT NULL DEFAULT '{}',
    analyzed_by      BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_by       BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_assignment_cards_chat ON chat_assignment_cards (tenant_id, chat_id);
