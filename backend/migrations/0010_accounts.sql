-- TEAMCRM — глобальная идентичность: один аккаунт (email+пароль) → членство в нескольких организациях.
-- users остаётся строкой-членством в организации (на неё завязаны все доменные FK).
-- accounts — глобальная личность для входа.

CREATE TABLE accounts (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name     VARCHAR(160) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_accounts_email ON accounts (lower(email));

ALTER TABLE users ADD COLUMN account_id BIGINT NULL REFERENCES accounts(id);
CREATE INDEX idx_users_account ON users (account_id);

-- Бэкофилл: по одному аккаунту на уникальный e-mail (первый по дате создания),
-- затем связываем все членства с этим аккаунтом.
INSERT INTO accounts (email, password_hash, full_name)
SELECT DISTINCT ON (lower(email)) email, password_hash, full_name
  FROM users
 ORDER BY lower(email), created_at ASC;

UPDATE users u
   SET account_id = a.id
  FROM accounts a
 WHERE lower(u.email) = lower(a.email);
