-- #4807 §6: «Входящие» — одно место для всего, что ждёт реакции человека. Основа —
-- уже существующий ящик уведомлений (строка на событие одному человеку); здесь —
-- «Готово» (убрать из списка, объект не меняется) и «Отложить до…».
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS done_at timestamptz;
ALTER TABLE notification_inbox ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
CREATE INDEX IF NOT EXISTS notification_inbox_box_idx
    ON notification_inbox (user_id, tenant_id, done_at, created_at DESC);
