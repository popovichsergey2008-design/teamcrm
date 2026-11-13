-- #4902, п. 10–11: итоги созвона приходят в чат сами, каждый подтверждает свои задачи.

-- Карточки встречи в чатах: итог в чате, откуда звонили (recap), личный список задач
-- в «Заметках» участника (confirm), сбой обработки с «Повторить» (error).
-- Одна карточка каждого вида на встречу (и на человека — для confirm): повторный
-- разбор и вторая выкладка не шлют дублей. Само сообщение — обычное chat_messages
-- с meeting_id, поэтому в письмах и выгрузках остаётся человекочитаемый текст.
CREATE TABLE IF NOT EXISTS meeting_chat_cards (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    meeting_id  BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    kind        VARCHAR(16) NOT NULL CHECK (kind IN ('recap', 'confirm', 'error')),
    user_id     BIGINT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id  BIGINT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    -- неподтверждённые задачи за 24 ч — одно напоминание на карточку
    reminded_at TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_chat_cards ON meeting_chat_cards (meeting_id, kind, COALESCE(user_id, 0));
CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_chat_cards_msg ON meeting_chat_cards (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meeting_chat_cards_remind ON meeting_chat_cards (created_at) WHERE kind = 'confirm' AND reminded_at IS NULL;

-- Ответ исполнителя по своей задаче: «✓ беру» (taken) или «не моё» (declined).
-- Отдельно от status: задача могла создаться сама (автосоздание) — подтверждение
-- исполнителя от этого не перестаёт быть нужным.
ALTER TABLE meeting_task_drafts ADD COLUMN IF NOT EXISTS confirm_state VARCHAR(16) NULL;
ALTER TABLE meeting_task_drafts ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ NULL;
ALTER TABLE meeting_task_drafts ADD COLUMN IF NOT EXISTS confirmed_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL;

-- «Ошибка» повторяется автоматически один раз: когда повторить и был ли уже повтор.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS auto_retry_at TIMESTAMPTZ NULL;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS auto_retried_at TIMESTAMPTZ NULL;
-- Название придумал ИИ вместо «Созвон 11.11, 09:22» — второй раз не переименовываем.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS title_ai BOOLEAN NOT NULL DEFAULT FALSE;
-- «Пересказ за 1 минуту»: текст и озвучка один раз на встречу — повторное нажатие бесплатно.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS retell_text TEXT NULL;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS retell_file_id BIGINT NULL REFERENCES files(id) ON DELETE SET NULL;
