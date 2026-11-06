-- #4787 (ТЗ календаря, п. 10–11): карточка встречи полезна до и после созвона.
--
-- goal — какой результат хотим получить («согласовать главную страницу»); что обсуждаем —
-- описание события, как и было.
-- calendar_event_tasks — задачи, связанные со встречей: «посмотреть перед встречей»
-- (linked) и созданные из её итогов (meeting). По ним через неделю видно, чем закончилось.
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS goal VARCHAR(500) NULL;

CREATE TABLE IF NOT EXISTS calendar_event_tasks (
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    event_id   BIGINT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    task_id    BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    source     VARCHAR(8) NOT NULL DEFAULT 'linked' CHECK (source IN ('linked', 'meeting')),
    created_by BIGINT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_event_tasks_task ON calendar_event_tasks (tenant_id, task_id);
