-- Догоняющий вопрос по задаче (ТЗ-11, разд. 50).
--
-- За несколько часов до срока ассистент спрашивает исполнителя, как идёт работа, и
-- даёт три ответа: успеваю, есть блокер, нужен перенос. Смысл не в напоминании — их и
-- так хватает, — а в том, чтобы постановщик узнал о срыве ДО срока, а не после.
--
-- «No-nagging» в названии раздела ТЗ означает ровно одно: спросить один раз про один
-- срок. Поэтому ключ — задача и её срок: перенесли срок — спросим про новый, не
-- перенесли — второй раз не тронем.
CREATE TABLE IF NOT EXISTS task_followups (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    task_id     BIGINT      NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    -- Кого спросили: исполнитель на момент вопроса.
    user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Про какой срок спрашивали.
    deadline_at TIMESTAMPTZ NOT NULL,
    asked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- on_track | blocked | need_shift; NULL — ещё не ответили.
    answer      VARCHAR(16) NULL,
    answered_at TIMESTAMPTZ NULL,
    -- Напоминание, которым спросили: по нему ответ гасит строку в сводке.
    ping_id     BIGINT      NULL REFERENCES assistant_pings(id) ON DELETE SET NULL,
    UNIQUE (task_id, deadline_at)
);

CREATE INDEX IF NOT EXISTS task_followups_open_idx
    ON task_followups (tenant_id, user_id)
    WHERE answer IS NULL;
