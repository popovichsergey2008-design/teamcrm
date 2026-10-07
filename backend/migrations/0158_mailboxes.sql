-- ТЗ-18, почта (§8.1–8.2, решение заказчика 07.10: «все возможные ящики, в интеграции»).
--
-- Личный ящик сотрудника подключается по IMAP/SMTP с паролем приложения — так
-- работают Gmail, Яндекс, Mail.ru и любой свой сервер, без регистрации приложения у
-- каждого почтовика. Пароль — шифрованный (IntegrationCryptoService), наружу не отдаётся.
-- Ящик личный: его письма видит и разбирает только владелец ящика.

CREATE TABLE mail_accounts (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider      VARCHAR(16) NOT NULL,            -- gmail | yandex | mailru | outlook | custom
    email         VARCHAR(255) NOT NULL,
    username      VARCHAR(255) NOT NULL,
    imap_host     VARCHAR(255) NOT NULL,
    imap_port     INT NOT NULL,
    smtp_host     VARCHAR(255) NOT NULL,
    smtp_port     INT NOT NULL,
    secret_enc    TEXT NOT NULL,
    -- ok | error: ящик, который перестал пускать, не мучаем каждые 5 минут
    status        VARCHAR(16) NOT NULL DEFAULT 'ok',
    last_error    TEXT NULL,
    last_sync_at  TIMESTAMPTZ NULL,
    last_uid      BIGINT NOT NULL DEFAULT 0,
    uid_validity  BIGINT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, email)
);
CREATE INDEX idx_mail_accounts_sync ON mail_accounts (status, last_sync_at);

CREATE TABLE mail_messages (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id    BIGINT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
    uid           BIGINT NOT NULL,
    message_id    VARCHAR(512) NULL,
    from_email    VARCHAR(255) NULL,
    from_name     VARCHAR(255) NULL,
    to_emails     TEXT[] NOT NULL DEFAULT '{}',
    subject       TEXT NULL,
    sent_at       TIMESTAMPTZ NULL,
    -- текст письма без вложений, обрезанный: для сводки, поиска и ответа хватает
    body_text     TEXT NULL,
    -- critical | action | client | invoice | fyi | newsletter (§8.1)
    category      VARCHAR(16) NOT NULL DEFAULT 'fyi',
    reason        VARCHAR(160) NULL,
    client_id     BIGINT NULL REFERENCES clients(id) ON DELETE SET NULL,
    is_read       BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (account_id, uid)
);
CREATE INDEX idx_mail_messages_user ON mail_messages (tenant_id, user_id, sent_at DESC);
CREATE INDEX idx_mail_messages_cat ON mail_messages (user_id, category) WHERE NOT is_read;
