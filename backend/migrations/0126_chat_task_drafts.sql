-- Черновик задачи из сообщения чата (ТЗ «Создание задач из сообщений в чате»).
--
-- Зачем хранить, а не держать в окне. Между «Создать задачу» и «Создать» проходит
-- время: ИИ разбирает фразу, а если проект не определён — бот спрашивает автора
-- сообщения прямо в чате и ждёт ответа. Всё это должно пережить F5, переход в другой
-- раздел, обрыв связи и повторный вход, иначе начатое приходится начинать заново.
--
-- Черновик живёт до завершения (created/cancelled) и хранит ровно то, что человек
-- увидит в предпросмотре и сможет поправить.
CREATE TABLE IF NOT EXISTS chat_task_drafts (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    chat_id         BIGINT      NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id      BIGINT      NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    -- Кто нажал «Создать задачу»: он же станет постановщиком.
    initiator_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Автор исходного сообщения: ему адресован уточняющий вопрос.
    author_id       BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    -- analyzing | needs_clarification | ready | created | cancelled | failed
    status          TEXT        NOT NULL DEFAULT 'analyzing',
    title           TEXT        NOT NULL DEFAULT '',
    description     TEXT        NOT NULL DEFAULT '',
    project_id      BIGINT      NULL REFERENCES projects(id) ON DELETE SET NULL,
    assignee_id     BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    -- Почему предложен именно он: «назван через @», «подобран по навыкам и загрузке».
    assignee_reason TEXT        NULL,
    deadline        DATE        NULL,
    priority        TEXT        NOT NULL DEFAULT 'normal',
    checklist       JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- Вложения сообщения: [{fileId, name, mime, include}] — файл не копируем, а
    -- привязываем к задаче второй раз (это та же картинка).
    files           JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- Что решил ИИ: отдел, специализация, уверенность, откуда взялся проект.
    analysis        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- Сообщение бота с вопросом: по нему находим ответ автора.
    question_message_id BIGINT  NULL REFERENCES chat_messages(id) ON DELETE SET NULL,
    task_id         BIGINT      NULL REFERENCES tasks(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Открытые черновики чата: по ним рисуются строки состояния под сообщениями.
CREATE INDEX IF NOT EXISTS chat_task_drafts_open_idx
    ON chat_task_drafts (tenant_id, chat_id)
    WHERE status IN ('analyzing', 'needs_clarification', 'ready');

CREATE INDEX IF NOT EXISTS chat_task_drafts_message_idx ON chat_task_drafts (message_id);
