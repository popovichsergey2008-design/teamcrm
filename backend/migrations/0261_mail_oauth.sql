-- #4893, п. 2: почта кнопкой — вход через Яндекс, Google, Mail.ru по OAuth вместо пароля приложения.
--
-- Ящик, подключённый кнопкой, живёт в той же mail_accounts: забор, разбор, поиск и
-- черновики работают по нему без изменений, отличается только вход (XOAUTH2).
-- У такого ящика secret_enc хранит шифрованный refresh-токен (вместо пароля приложения),
-- а короткий access-токен с его сроком — отдельно, чтобы не обновлять его на каждом заборе.

ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS auth_kind VARCHAR(16) NOT NULL DEFAULT 'password'; -- password | oauth
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(16) NULL;                   -- yandex | google | mailru
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS oauth_access_enc TEXT NULL;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS oauth_expires_at TIMESTAMPTZ NULL;
