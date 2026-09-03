-- Треды: обсуждение одного сообщения отдельной веткой.
--
-- Без них рабочий чат превращается в Telegram-группу: пять разговоров идут вперемешку,
-- и через полчаса непонятно, кто кому отвечает. Ветка держит обсуждение при своём
-- сообщении, а основная лента остаётся читаемой.
ALTER TABLE chat_messages ADD COLUMN thread_root_id BIGINT NULL REFERENCES chat_messages(id) ON DELETE CASCADE;

-- «Также отправить в основной чат» — как в Slack.
--
-- Иногда ответ важен не только участникам ветки. Тогда сообщение живёт и в треде,
-- и в общей ленте; отдельной копии не заводим — две записи об одном сообщении
-- разъезжаются при правке и удалении.
ALTER TABLE chat_messages ADD COLUMN also_in_channel BOOLEAN NOT NULL DEFAULT FALSE;

-- Счётчик ответов и время последнего — на самом корневом сообщении.
--
-- Считать подзапросом на каждое сообщение ленты дорого: в чате на десять тысяч
-- сообщений это десять тысяч подсчётов ради строчки «7 ответов».
ALTER TABLE chat_messages ADD COLUMN reply_count INT NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN last_reply_at TIMESTAMPTZ NULL;

-- Лента читает только корни (и то, что попросили продублировать в канал).
CREATE INDEX idx_chat_messages_root ON chat_messages (chat_id, id DESC)
    WHERE thread_root_id IS NULL;
-- Ветка читается целиком и по возрастанию.
CREATE INDEX idx_chat_messages_thread ON chat_messages (thread_root_id, id)
    WHERE thread_root_id IS NOT NULL;

-- Прочтение ветки — отдельно от прочтения чата.
--
-- Человек может прочитать канал, но не открыть ветку, где ему ответили. Раздел
-- «Треды» существует ровно ради этого случая: показать, где ждут именно его.
CREATE TABLE chat_thread_reads (
    root_id      BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (root_id, user_id)
);
CREATE INDEX idx_chat_thread_reads_user ON chat_thread_reads (tenant_id, user_id);
