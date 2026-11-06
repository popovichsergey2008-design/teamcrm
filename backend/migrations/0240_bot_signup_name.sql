-- #4779, п. 13: «Начать бесплатно» в демо-доске — бот спрашивает название рабочей зоны и ждёт ответ
ALTER TABLE telegram_bot_users ADD COLUMN IF NOT EXISTS signup_asked_at TIMESTAMPTZ NULL;
ALTER TABLE telegram_bot_users ADD COLUMN IF NOT EXISTS signup_name VARCHAR(160) NULL;
