-- Несколько файлов в одном сообщении.
--
-- Было: у сообщения ровно один файл (chat_messages.file_id). Человек вставляет из
-- буфера три снимка — получает три сообщения подряд, и разговор превращается в
-- ленту обрывков. В мессенджерах это одно сообщение с несколькими картинками, и
-- заказчик просит ровно этого.
--
-- Старое поле НЕ убираем: на него завязаны выборки ленты, поиск, задачи из
-- сообщений и вложения, приехавшие из Битрикса и YouGile. Оно продолжает хранить
-- ПЕРВЫЙ файл сообщения — так любой старый код продолжает работать и показывать
-- хотя бы первую картинку, а новый берёт полный список отсюда.
CREATE TABLE chat_message_files (
    message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    file_id    BIGINT NOT NULL REFERENCES files(id),
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    -- Порядок показа: человек прикладывает снимки в осмысленной последовательности.
    position   INT NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, file_id)
);

CREATE INDEX idx_message_files ON chat_message_files (message_id, position);

-- Переносим то, что уже есть: одно вложение = список из одного элемента. Без этого
-- старые сообщения показывались бы по-старому, а новые по-новому — и разница
-- вылезла бы в первом же разговоре.
INSERT INTO chat_message_files (message_id, file_id, tenant_id, position)
SELECT id, file_id, tenant_id, 0 FROM chat_messages WHERE file_id IS NOT NULL
ON CONFLICT DO NOTHING;
