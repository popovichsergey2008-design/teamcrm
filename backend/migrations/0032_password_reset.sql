-- Сброс пароля. Почтовой рассылки в проекте нет, поэтому ссылка выдаётся владельцем
-- организации и передаётся сотруднику лично — тем же способом, что и приглашения.
-- Пароль живёт на уровне ГЛОБАЛЬНОГО аккаунта (accounts), поэтому и сброс привязан к нему.

CREATE TABLE password_resets (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id  BIGINT NOT NULL REFERENCES accounts(id),
    tenant_id   BIGINT NULL REFERENCES tenants(id),   -- из какой организации выдали (аудит)
    created_by  BIGINT NULL REFERENCES users(id),     -- кто выдал (аудит)
    token_hash  VARCHAR(64) NOT NULL,                 -- sha256 токена; сам токен нигде не хранится
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ NULL,                     -- одноразовость
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_password_resets_token ON password_resets (token_hash);
-- поиск действующих токенов аккаунта (при выдаче новой ссылки старые гасим)
CREATE INDEX idx_password_resets_account ON password_resets (account_id, used_at, expires_at);
