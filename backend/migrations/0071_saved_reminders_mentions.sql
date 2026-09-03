-- Слой 2 ТЗ-3: ничего не теряется.
--
-- Три разные потери, которые до сих пор случались каждый день:
--   1) прочитал важное, отвлёкся — и больше не нашёл;
--   2) прочитал не вовремя («сделаю вечером») — и забыл;
--   3) позвали по имени в чате, где сто сообщений в день, — и не заметил.

-- Сохранённое: важное под рукой, без превращения в задачу.
--
-- Не всё, что нужно помнить, — работа. Ссылка на макет, кусок кода, решение по
-- спорному вопросу: задача из них не получается, а искать их прокруткой невозможно.
CREATE TABLE saved_messages (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    note       VARCHAR(200) NULL,
    saved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, message_id)
);
CREATE INDEX idx_saved_messages_user ON saved_messages (tenant_id, user_id, saved_at DESC);

-- «Напомнить мне»: сообщение вернётся в нужный момент.
--
-- Читают сообщения тогда, когда пришли, а сделать по ним нужно позже. Держать это
-- в голове — и есть та работа, которую система обязана снять с человека.
CREATE TABLE message_reminders (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    remind_at  TIMESTAMPTZ NOT NULL,
    -- напоминание сработало (или человек снял его сам): в выборку оно больше не идёт
    done_at    TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Планировщик каждую минуту спрашивает «что уже пора»: индекс ровно под этот запрос.
CREATE INDEX idx_message_reminders_due ON message_reminders (remind_at) WHERE done_at IS NULL;
CREATE INDEX idx_message_reminders_user ON message_reminders (tenant_id, user_id, remind_at);

-- Упоминания в мессенджере — как в ленте компании.
--
-- Список приходит от подсказки по «@» и проверяется на стороне сервера: имя в тексте
-- после переименования сотрудника указывало бы в никуда, а id — нет.
CREATE TABLE chat_mentions (
    message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    -- прочитано ли упоминание: раздел «Входящие» существует ради непрочитанных
    seen_at    TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX idx_chat_mentions_user ON chat_mentions (tenant_id, user_id, created_at DESC);
