-- Подготовка к коммерческому релизу (мастер-план, этап 3 «Авторизация и защита аккаунтов»).
--
-- Три вещи, которых не было:
--   1. Подтверждение почты. Новый аккаунт приходит неподтверждённым, ссылка уходит письмом.
--      Все, кто уже работает, считаются подтверждёнными — их адреса проверены временем
--      (приглашения, письма о задачах), и внезапная плашка «подтвердите почту» у сотни
--      людей принесла бы только вопросы в поддержку.
--   2. Двухфакторный вход по коду из приложения (TOTP) с одноразовыми резервными кодами.
--   3. «Забыли пароль?» письмом: раньше ссылку выдавал только владелец организации.
--      Таблица password_resets та же — у самостоятельного сброса нет автора (created_by NULL).

ALTER TABLE accounts
    ADD COLUMN email_verified_at TIMESTAMPTZ NULL,
    -- секрет TOTP только шифрованным (AES-256-GCM, как токены интеграций)
    ADD COLUMN totp_secret_enc   TEXT NULL,
    ADD COLUMN totp_enabled_at   TIMESTAMPTZ NULL,
    -- шаг времени последнего принятого кода: тот же код второй раз не пройдёт
    ADD COLUMN totp_last_step    BIGINT NULL;

UPDATE accounts SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- Ссылки подтверждения почты. Как у сброса пароля: в базе только sha256, одноразовые,
-- с концом срока. email — на какой адрес слали: сменили адрес — старая ссылка не годится.
CREATE TABLE email_verifications (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email       VARCHAR(255) NOT NULL,
    token_hash  VARCHAR(64) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_email_verifications_token ON email_verifications (token_hash);
CREATE INDEX idx_email_verifications_account ON email_verifications (account_id, used_at);

-- Резервные коды на случай потерянного телефона. Каждый срабатывает один раз.
CREATE TABLE account_recovery_codes (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    code_hash   VARCHAR(64) NOT NULL,
    used_at     TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_account_recovery_codes_account ON account_recovery_codes (account_id, used_at);
