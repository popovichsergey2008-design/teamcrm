-- #4615 «Автоматическое создание задач через нейросеть».
--
-- 1. Отдел ↔ направления: задача по направлению уходит руководителю отдела
--    (lead_user_id уже есть с 0007, не был заполнен).
-- 2. «Подтверждено постановщиком» у задачи: «Ок» в сообщении через 30 секунд.
-- 3. Отложенное сообщение-подтверждение: запись в базе, а не таймер в памяти —
--    переживает перезапуск сервера и не уходит дважды при двух API (blue/green).

ALTER TABLE groups ADD COLUMN IF NOT EXISTS directions TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS manager_confirmed_at TIMESTAMPTZ NULL;

CREATE TABLE IF NOT EXISTS task_auto_confirm (
    task_id     BIGINT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- постановщик
    due_at      TIMESTAMPTZ NOT NULL,
    -- отпечаток полей задачи сразу после создания (название, описание, исполнитель,
    -- проект, срок, приоритет): изменился — постановщик уже поправил
    snap        VARCHAR(32) NOT NULL DEFAULT '',
    -- почему такой проект и исполнитель — словами, для сообщения
    info        JSONB NOT NULL DEFAULT '{}'::jsonb,
    sent_at     TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_auto_confirm_due ON task_auto_confirm (due_at) WHERE sent_at IS NULL;
