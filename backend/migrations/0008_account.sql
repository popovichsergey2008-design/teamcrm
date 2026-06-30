-- TEAMCRM Enhancements v1, Этап C — личный кабинет (профиль, аватар, уведомления, сессии).

ALTER TABLE users
    ADD COLUMN avatar_file_id BIGINT NULL REFERENCES files(id),
    ADD COLUMN phone          VARCHAR(32) NULL,
    ADD COLUMN timezone       VARCHAR(48) NOT NULL DEFAULT 'Europe/Moscow',
    ADD COLUMN locale         VARCHAR(8)  NOT NULL DEFAULT 'ru',
    ADD COLUMN notify_prefs   JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Метаданные сессий для списка устройств (дополняет refresh_tokens).
ALTER TABLE refresh_tokens
    ADD COLUMN user_agent   VARCHAR(255) NULL,
    ADD COLUMN ip           VARCHAR(64)  NULL,
    ADD COLUMN last_used_at TIMESTAMPTZ  NULL;
