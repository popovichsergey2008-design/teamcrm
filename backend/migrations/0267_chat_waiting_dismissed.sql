-- #4902, п. 6: «Не мне» в списке «Ждут вашего ответа» — вопрос больше не показывается.
CREATE TABLE IF NOT EXISTS chat_waiting_dismissed (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, message_id)
);
