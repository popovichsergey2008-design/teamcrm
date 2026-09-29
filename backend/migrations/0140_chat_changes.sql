-- ТЗ-12, этап 7: финальное состояние разговора.
--
-- Задачу завели, а позже в том же чате написали «не делай, клиент передумал», «пусть
-- лучше Глеб возьмёт» или «давайте до понедельника». Агент такую задачу молча НЕ
-- трогает (ТЗ разд. 30): он замечает изменение и спрашивает постановщика. Изменение —
-- отдельный вид наблюдения, привязанный к уже существующей задаче (task_id).

ALTER TABLE chat_extracted_actions DROP CONSTRAINT IF EXISTS chat_action_type_known;
ALTER TABLE chat_extracted_actions ADD CONSTRAINT chat_action_type_known CHECK (action_type IN (
    'task', 'decision', 'meeting', 'question', 'status', 'blocker', 'idea', 'change'));

-- Что именно изменилось: cancel — поручение отменили, reassign — сменили исполнителя
-- (новый — в assignee_id), deadline — перенесли срок (новый — в deadline_at).
ALTER TABLE chat_extracted_actions ADD COLUMN IF NOT EXISTS change_kind TEXT NULL;
ALTER TABLE chat_extracted_actions DROP CONSTRAINT IF EXISTS chat_action_change_kind;
ALTER TABLE chat_extracted_actions ADD CONSTRAINT chat_action_change_kind
    CHECK (change_kind IS NULL OR change_kind IN ('cancel', 'reassign', 'deadline'));
