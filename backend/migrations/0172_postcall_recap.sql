-- ТЗ-22, этапы 5–6: итоги участникам и напоминание о неразобранных итогах.
-- recap_sent_at — «Отправить итоги участникам» уже нажимали: второй раз людей не дёргаем.
-- notified_at — владельцу уже сказали «итоги готовы» (он ушёл с экрана раньше, чем они собрались).
ALTER TABLE meeting_postcall_reviews ADD COLUMN IF NOT EXISTS recap_sent_at TIMESTAMPTZ NULL;
ALTER TABLE meeting_postcall_reviews ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ NULL;
