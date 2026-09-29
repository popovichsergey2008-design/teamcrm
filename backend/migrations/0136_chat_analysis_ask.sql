-- ТЗ-12, этап 3: уточняющий вопрос в чате.
--
-- Агент понял, что это поручение, но не понял, к какому проекту оно относится или кто
-- его сделает. Спросить об этом может только человек, который писал, и спрашивать надо
-- там же, где он пишет, — в чате. Ответ дозаполняет наблюдение.
--
-- Вопрос задаётся ОДИН раз на наблюдение: «спросили» отмечаем сообщением бота, и второй
-- раз к человеку не возвращаемся. Молчание — это тоже ответ.
ALTER TABLE chat_extracted_actions
    ADD COLUMN IF NOT EXISTS question_message_id BIGINT NULL REFERENCES chat_messages(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS asked_at TIMESTAMPTZ NULL;

-- Ждущие ответа наблюдения чата: по ним ловим ответ на вопрос.
CREATE INDEX IF NOT EXISTS chat_extracted_actions_awaiting_idx
    ON chat_extracted_actions (tenant_id, chat_id)
    WHERE question_message_id IS NOT NULL AND status = 'needs_clarification';

-- Выключатель на организацию: бот пишет в рабочие чаты, и это должно быть решением
-- владельца, а не побочным действием включённого разбора.
ALTER TABLE chat_analysis_settings
    ADD COLUMN IF NOT EXISTS ask_in_chat BOOLEAN NOT NULL DEFAULT TRUE;
