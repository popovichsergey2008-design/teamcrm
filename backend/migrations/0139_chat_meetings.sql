-- ТЗ-12, этап 6: встречи из переписки.
--
-- «Давайте завтра в 15:00 созвонимся по интеграции» — агент замечает договорённость,
-- человек одним нажатием ставит её в календарь. Готовое событие календаря с
-- приглашениями и напоминаниями переиспользуем целиком; здесь — только то, чего ему не
-- хватало, чтобы знать, откуда встреча взялась.

ALTER TABLE chat_extracted_actions
    -- Кого звать: договаривавшиеся и названные по имени, организатор первым.
    -- Всю команду проекта не зовём никогда (ТЗ разд. 36).
    ADD COLUMN IF NOT EXISTS participant_ids BIGINT[] NOT NULL DEFAULT '{}',
    -- Названа дата, но не время: бот спрашивает время у организатора (разд. 35).
    ADD COLUMN IF NOT EXISTS meeting_date DATE NULL,
    ADD COLUMN IF NOT EXISTS duration_minutes INT NULL;

-- Событие, поставленное по договорённости в чате, помнит, где договорились: из
-- карточки события — одним нажатием в переписку (разд. 23).
ALTER TABLE calendar_events
    ADD COLUMN IF NOT EXISTS source_chat_id BIGINT NULL REFERENCES chats(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS source_chat_message_id BIGINT NULL REFERENCES chat_messages(id) ON DELETE SET NULL;
