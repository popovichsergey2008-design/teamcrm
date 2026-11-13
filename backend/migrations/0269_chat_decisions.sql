-- #4902, п. 9: «Решения» — отдельная вкладка чата проекта.
--
-- Журнал решений уже есть (0138: decisions — и из переписки, и со встреч). Вкладке не
-- хватало трёх вещей: есть ли по решению задача, выполнено ли оно, и что ИИ предлагал,
-- но человек ещё не подтвердил. Плюс вопросы без ответа, которые «решают» опросом или созвоном.

-- Задача по решению и ручная отметка «выполнено». Выполнено — если задача закрыта
-- или отметили руками; снять отметку можно (done_at = NULL).
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS task_id BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ NULL;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS done_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS decisions_source_msg_idx ON decisions (source_message_id) WHERE source_message_id IS NOT NULL;

-- Кандидаты в решения: сообщение похоже на решение (правила или модель). Решением
-- становится только по подтверждению человека; «не решение» запоминается, чтобы
-- кандидат не возвращался при каждом открытии вкладки.
CREATE TABLE IF NOT EXISTS chat_decision_candidates (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    chat_id     BIGINT      NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id  BIGINT      NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    text        TEXT        NOT NULL,
    origin      VARCHAR(8)  NOT NULL CHECK (origin IN ('rules', 'ai')),
    status      VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    decision_id BIGINT      NULL REFERENCES decisions(id) ON DELETE SET NULL,
    resolved_by BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_decision_candidates ON chat_decision_candidates (message_id);
CREATE INDEX IF NOT EXISTS idx_chat_decision_candidates_chat ON chat_decision_candidates (chat_id, status);

-- Вопросы без ответа: что с ними сделали. Вопрос — сообщение чата или открытый
-- вопрос из протокола встречи этого чата; ключ — 'm:<id сообщения>' или 'q:<встреча>:<номер>'.
-- poll — запущен опрос (пост «Новостей»), call — позвали на созвон, decided — решили
-- (появилось решение), dismissed — «не вопрос».
CREATE TABLE IF NOT EXISTS chat_question_states (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    chat_id      BIGINT      NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    question_key VARCHAR(64) NOT NULL,
    state        VARCHAR(10) NOT NULL CHECK (state IN ('poll', 'call', 'decided', 'dismissed')),
    poll_post_id BIGINT      NULL,
    decision_id  BIGINT      NULL REFERENCES decisions(id) ON DELETE SET NULL,
    updated_by   BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_question_states ON chat_question_states (chat_id, question_key);
