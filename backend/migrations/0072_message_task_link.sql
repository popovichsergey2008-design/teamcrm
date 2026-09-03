-- Слой 3 ТЗ-3: разговор превращается в работу и не теряет источник.
--
-- Самый частый способ появления задачи — фраза в чате: «на мобильной версии блок
-- съезжает». Сейчас её переписывают руками в форму создания, теряя половину смысла
-- и весь контекст. Теперь задача создаётся из самого сообщения.
--
-- Связь двусторонняя намеренно. Из сообщения видно, что по нему уже завели задачу
-- (иначе заведут вторую), а из задачи — откуда она взялась. Вопрос «а это вообще
-- откуда?» через неделю после постановки — самый частый на разборах.
ALTER TABLE chat_messages ADD COLUMN task_id BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN source_chat_message_id BIGINT NULL REFERENCES chat_messages(id) ON DELETE SET NULL;

CREATE INDEX idx_chat_messages_task ON chat_messages (task_id) WHERE task_id IS NOT NULL;
