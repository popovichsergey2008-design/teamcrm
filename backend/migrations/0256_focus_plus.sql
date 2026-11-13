-- #4891 ТЗ «Фокус дня»: что внедрить.

-- По задаче у человека: следующий шаг, ожидаемый результат, оценка, предложенная ИИ
-- («≈ 2 ч · предложил ИИ · верно / изменить»), и шаг, записанный при выходе из фокуса —
-- с него продолжаем следующий старт.
CREATE TABLE IF NOT EXISTS task_focus_notes (
    task_id         BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
    next_step       VARCHAR(500) NULL,
    result          VARCHAR(500) NULL,
    ai_estimate_min INT NULL,
    steps_done      TEXT[] NOT NULL DEFAULT '{}',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, user_id)
);

-- «Отложить до…» для решений в очереди (п. 4): отложенное уходит из счётчика до даты.
CREATE TABLE IF NOT EXISTS focus_snoozes (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    item_key   VARCHAR(80) NOT NULL,
    until      TIMESTAMPTZ NOT NULL,
    remind     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, item_key)
);

-- «Принять план» и «Всё равно оставить» (п. 1а) — когда план принят с перегрузом.
ALTER TABLE focus_day_plans ADD COLUMN IF NOT EXISTS overload_accepted BOOLEAN NOT NULL DEFAULT FALSE;
