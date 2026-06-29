-- TEAMCRM Этап 3 — AI Standup Pipeline: привязка Telegram, машина состояний дейликов.

-- Привязка Telegram-аккаунта к пользователю CRM.
CREATE TABLE telegram_accounts (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id        BIGINT NOT NULL REFERENCES tenants(id),
    user_id          BIGINT NOT NULL REFERENCES users(id),
    telegram_user_id BIGINT NOT NULL,
    linked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (telegram_user_id),          -- один TG-аккаунт = один пользователь
    UNIQUE (tenant_id, user_id)
);

-- Одноразовые коды привязки.
CREATE TABLE telegram_link_codes (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    code        VARCHAR(16) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ NULL,
    UNIQUE (code)
);

-- Машина состояний дейлик-сабмишена.
CREATE TABLE standup_submissions (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id           BIGINT NOT NULL REFERENCES tenants(id),
    user_id             BIGINT NOT NULL REFERENCES users(id),
    telegram_message_id BIGINT NOT NULL,
    status              VARCHAR(32) NOT NULL,        -- см. state-machine
    audio_file_ref      VARCHAR(255) NULL,
    transcript_raw      TEXT NULL,                   -- чувствительные данные
    transcript_masked   TEXT NULL,                   -- то, что ушло в LLM
    parsed_json         JSONB NULL,                  -- валидированный по схеме результат
    confidence          NUMERIC(4,3) NULL,
    error_code          VARCHAR(48) NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at          TIMESTAMPTZ NULL,
    UNIQUE (telegram_message_id)                     -- дедуп доставки
);
CREATE INDEX idx_standup_status ON standup_submissions (tenant_id, status);

-- Применённые действия (аудит + окно отмены).
CREATE TABLE standup_actions (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    submission_id BIGINT NOT NULL REFERENCES standup_submissions(id),
    action_index  INT NOT NULL,
    task_id       BIGINT NULL REFERENCES tasks(id),
    kind          VARCHAR(32) NOT NULL,              -- status_change | time_log | blocker
    applied_time_log_id BIGINT NULL REFERENCES time_logs(id),
    result        VARCHAR(32) NOT NULL,              -- applied | rejected_foreign | rejected_invalid
    detail        JSONB NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (submission_id, action_index)             -- идемпотентность применения
);

-- Расписание опроса сотрудников.
CREATE TABLE standup_schedules (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    cron_expr    VARCHAR(64) NOT NULL,
    timezone     VARCHAR(48) NOT NULL,
    prompt_text  TEXT NOT NULL,
    target_role  VARCHAR(32) NULL,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE
);

-- Переключатель авто-применения на уровне арендатора.
ALTER TABLE tenants
    ADD COLUMN standup_auto_apply BOOLEAN NOT NULL DEFAULT FALSE;
