-- #4787 (ТЗ календаря, п. 3, 4, 5, 12): «когда закончить» и «когда делать» — разные вещи.
--
-- Срок задачи (tasks.deadline_at) — до какого момента нужен результат. Блок — когда человек
-- собирается этим заниматься. У одной задачи может быть несколько подходов, и передвинутый
-- блок срок не трогает. Блок — не копия задачи: он ссылается на неё, а открывается сама задача.
--
-- kind = 'task'  — время на задачу (task_id обязателен);
-- kind = 'focus' — запланированный глубокий фокус (задачи — task_ids, может быть пусто).
-- Блок всегда в СВОЁМ расписании: ставит его только сам человек (п. 11 — в чужое расписание
-- незаметно обязательный блок не поставить).
CREATE TABLE calendar_blocks (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    kind        VARCHAR(8) NOT NULL CHECK (kind IN ('task', 'focus')),
    task_id     BIGINT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    task_ids    BIGINT[] NOT NULL DEFAULT '{}',
    title       VARCHAR(300) NULL,
    starts_at   TIMESTAMPTZ NOT NULL,
    ends_at     TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    CHECK (kind <> 'task' OR task_id IS NOT NULL)
);
CREATE INDEX idx_calendar_blocks_user ON calendar_blocks (tenant_id, user_id, starts_at);
CREATE INDEX idx_calendar_blocks_task ON calendar_blocks (tenant_id, task_id) WHERE task_id IS NOT NULL;
