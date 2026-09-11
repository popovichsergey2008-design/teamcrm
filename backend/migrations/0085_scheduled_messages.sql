-- Отложенные сообщения: написать сейчас, отправить потом.
--
-- Зачем: напомнить о встрече за полчаса, поздравить утром, отправить вопрос
-- коллеге в его рабочее время, а не в час ночи. Так это устроено в Telegram, и
-- заказчик просил ровно того же.
--
-- Сообщение до срока живёт ЗДЕСЬ, а не в чате: положить его сразу в chat_messages
-- с датой в будущем нельзя — оно тут же уедет собеседнику по сокету и покажется
-- в ленте. Отправкой занимается планировщик: в назначенный час он проводит текст
-- обычным путём отправки, со всеми уведомлениями и упоминаниями.
CREATE TABLE chat_scheduled (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id),
    chat_id        BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    author_id      BIGINT NOT NULL REFERENCES users(id),
    body           TEXT NOT NULL,
    -- Ответ в ветке тоже можно отложить: договорённость о времени — частый случай.
    thread_root_id BIGINT NULL REFERENCES chat_messages(id),
    also_in_channel BOOLEAN NOT NULL DEFAULT FALSE,
    -- Кого позвали через «@»: список нужен в момент ОТПРАВКИ, а не сейчас.
    mention_ids    BIGINT[] NOT NULL DEFAULT '{}',
    send_at        TIMESTAMPTZ NOT NULL,
    -- Что с ним стало: pending → sent | cancelled | failed.
    status         VARCHAR(12) NOT NULL DEFAULT 'pending',
    sent_message_id BIGINT NULL REFERENCES chat_messages(id),
    error          TEXT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at        TIMESTAMPTZ NULL
);

-- Планировщик спрашивает только одно: «что уже пора». Частичный индекс держит в
-- памяти лишь ожидающие строки — отправленные копятся годами и ему не нужны.
CREATE INDEX idx_chat_scheduled_due ON chat_scheduled (send_at)
    WHERE status = 'pending';
-- Человеку показываем его отложенные в конкретном чате.
CREATE INDEX idx_chat_scheduled_mine ON chat_scheduled (tenant_id, chat_id, author_id, status);
