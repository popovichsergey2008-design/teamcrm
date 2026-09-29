-- ТЗ-12, этап 1: каркас разбора переписки.
--
-- Что здесь заводится и чего здесь НЕТ. На этом этапе агент только читает и
-- показывает, что понял: ни задач, ни встреч, ни решений он не создаёт. Поэтому
-- таблицы описывают наблюдение, а не действие: прогон, найденные смыслы и — главное —
-- сообщения, из которых каждый смысл вырос.
--
-- Решения заказчика от 29.09, на которых всё построено:
--   * режим «только предлагать»: автосоздание выключено и включается осознанно;
--   * ЛИЧНЫЕ переписки не разбираются ВООБЩЕ, без переключателя (см. ниже);
--   * мгновенного разбора каждого сообщения нет — только затихший разговор и
--     суточная сверка.

-- Настройки организации. Выключено по умолчанию: пока владелец сам не включит,
-- для всех всё остаётся как было.
CREATE TABLE IF NOT EXISTS chat_analysis_settings (
    tenant_id     BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    enabled       BOOLEAN NOT NULL DEFAULT FALSE,
    -- Сколько тишины считать концом разговора. Смысл переписки складывается к её
    -- концу — по одному сообщению он почти всегда другой.
    quiet_minutes INT     NOT NULL DEFAULT 20,
    -- suggest — только показывать найденное; auto_high — создавать при высокой
    -- уверенности. Значение по умолчанию выбрано заказчиком: сначала посмотреть.
    mode          TEXT    NOT NULL DEFAULT 'suggest',
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chat_analysis_mode_known CHECK (mode IN ('suggest', 'auto_high')),
    CONSTRAINT chat_analysis_quiet_sane CHECK (quiet_minutes BETWEEN 5 AND 240)
);

-- Выключить разбор у ОТДЕЛЬНОГО чата. Включено по умолчанию только у тех видов,
-- которые вообще разбираются, — см. условие в коде: личные (dm), заметки себе (self)
-- и внешние чаты не разбираются независимо от этого флага.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS ai_analysis BOOLEAN NOT NULL DEFAULT TRUE;

-- Один проход разбора: по какому куску переписки, чем и чем кончился.
CREATE TABLE IF NOT EXISTS chat_analysis_runs (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id        BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    chat_id          BIGINT      NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    -- segment — затихший разговор; daily — суточная сверка (этап 8).
    mode             TEXT        NOT NULL,
    status           TEXT        NOT NULL DEFAULT 'running',
    start_message_id BIGINT      NULL,
    end_message_id   BIGINT      NULL,
    messages         INT         NOT NULL DEFAULT 0,
    -- Модель и версия промпта: без них нельзя сравнить качество до и после правки.
    model            TEXT        NULL,
    prompt_version   TEXT        NULL,
    actions_count    INT         NOT NULL DEFAULT 0,
    error            TEXT        NULL,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ NULL,
    CONSTRAINT chat_analysis_run_mode CHECK (mode IN ('segment', 'daily')),
    CONSTRAINT chat_analysis_run_status CHECK (status IN ('running', 'done', 'failed'))
);
CREATE INDEX IF NOT EXISTS chat_analysis_runs_chat_idx
    ON chat_analysis_runs (tenant_id, chat_id, started_at DESC);

-- Что агент понял. Одна строка — один смысл: задача, решение, договорённость
-- о встрече, вопрос, статус, блокер, идея.
CREATE TABLE IF NOT EXISTS chat_extracted_actions (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    run_id        BIGINT      NOT NULL REFERENCES chat_analysis_runs(id) ON DELETE CASCADE,
    chat_id       BIGINT      NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    action_type   TEXT        NOT NULL,
    title         TEXT        NOT NULL DEFAULT '',
    description   TEXT        NOT NULL DEFAULT '',
    -- Кто поручил и кому. Постановщик отдельным полем: в переписке это почти никогда
    -- не тот, кто нажал бы кнопку, — и ошибка здесь дороже всех остальных.
    project_id    BIGINT      NULL REFERENCES projects(id) ON DELETE SET NULL,
    assigner_id   BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    assignee_id   BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    deadline_at   TIMESTAMPTZ NULL,
    meeting_at    TIMESTAMPTZ NULL,
    -- Уверенность по каждому полю отдельно: «понял задачу, но не понял чью» — это
    -- обычный случай, и одним числом его не выразить.
    intent_confidence   NUMERIC(4,3) NOT NULL DEFAULT 0,
    project_confidence  NUMERIC(4,3) NOT NULL DEFAULT 0,
    assigner_confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
    assignee_confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
    status        TEXT        NOT NULL DEFAULT 'detected',
    /*
      Ключ от повторной обработки. Тот же разговор попадёт и в затихший отрезок, и в
      ночную сверку; без ключа получилось бы два одинаковых наблюдения об одном и том
      же. Собирается из вида, сути, проекта, исполнителя и сообщений-источников.
    */
    dedup_key     TEXT        NOT NULL,
    created_entity_type TEXT  NULL,
    created_entity_id   BIGINT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chat_action_type_known CHECK (action_type IN (
        'task', 'decision', 'meeting', 'question', 'status', 'blocker', 'idea')),
    CONSTRAINT chat_action_status_known CHECK (status IN (
        'detected', 'needs_clarification', 'ready', 'auto_created',
        'confirmed', 'rejected', 'cancelled', 'superseded', 'failed'))
);
-- Одно наблюдение на смысл в организации: повтор молча пропускается.
CREATE UNIQUE INDEX IF NOT EXISTS chat_extracted_actions_dedup_idx
    ON chat_extracted_actions (tenant_id, dedup_key);
CREATE INDEX IF NOT EXISTS chat_extracted_actions_chat_idx
    ON chat_extracted_actions (tenant_id, chat_id, created_at DESC);

-- Сообщения, из которых вырос смысл. Без них наблюдение — это мнение ИИ, которое
-- нечем проверить; с ними человек одним нажатием видит исходный разговор.
CREATE TABLE IF NOT EXISTS chat_extracted_action_messages (
    action_id  BIGINT NOT NULL REFERENCES chat_extracted_actions(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    -- instruction — само поручение; acceptance — «ок, беру»; correction — правка;
    -- cancellation — отмена; decision — принятое решение; context — остальное.
    role       TEXT   NOT NULL DEFAULT 'context',
    PRIMARY KEY (action_id, message_id),
    CONSTRAINT chat_action_msg_role_known CHECK (role IN (
        'instruction', 'context', 'acceptance', 'correction', 'cancellation', 'decision'))
);
CREATE INDEX IF NOT EXISTS chat_extracted_action_messages_msg_idx
    ON chat_extracted_action_messages (message_id);

-- Докуда разобран каждый чат. Двигаем только после УДАЧНОГО прохода: если модель
-- недоступна, сообщения должны дождаться следующего раза, а не пропасть.
CREATE TABLE IF NOT EXISTS chat_analysis_checkpoints (
    tenant_id       BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    chat_id         BIGINT      NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    last_message_id BIGINT      NOT NULL DEFAULT 0,
    last_run_id     BIGINT      NULL REFERENCES chat_analysis_runs(id) ON DELETE SET NULL,
    last_run_at     TIMESTAMPTZ NULL,
    PRIMARY KEY (tenant_id, chat_id)
);
