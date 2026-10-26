-- #4619: Telegram-бот QEVO для сайта — демо без регистрации, аккаунт в один клик,
-- вход без пароля, пробный период 7 + 7 и заявки из бота.

-- 1. Человек в боте (ещё не сотрудник CRM): откуда пришёл, что выбрал, какое
--    пространство завёл через бота. Ключ — Telegram ID: другого у него пока нет.
CREATE TABLE IF NOT EXISTS telegram_bot_users (
  telegram_user_id BIGINT PRIMARY KEY,
  first_name       VARCHAR(120) NULL,
  username         VARCHAR(64)  NULL,
  -- метка из ссылки t.me/бот?start=<метка>: site, promo… — первая и последняя
  first_source     VARCHAR(32)  NULL,
  last_source      VARCHAR(32)  NULL,
  -- пространство, заведённое кнопкой «Забрать задачу» (повторно не заводится)
  tenant_id        BIGINT NULL REFERENCES tenants(id) ON DELETE SET NULL,
  user_id          BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  team_size        VARCHAR(16)  NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Попытки демо: карточка задачи, чем разобрана и во что обошлась. Это и лимит
--    (на человека и общий бюджет за сутки), и учёт расхода ИИ без организации —
--    в ai_usage его не положить: там tenant_id обязателен.
CREATE TABLE IF NOT EXISTS telegram_bot_demos (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL,
  input_kind       VARCHAR(16) NOT NULL CHECK (input_kind IN ('text', 'forward', 'voice', 'example')),
  mode             VARCHAR(8)  NOT NULL CHECK (mode IN ('ai', 'rules')),
  card             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  audio_seconds    INT NULL,
  elapsed_ms       INT NULL,
  cost_estimate    NUMERIC(10, 4) NOT NULL DEFAULT 0,
  -- карточку забрали в пространство: какая задача из неё вышла
  claimed_task_id  BIGINT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tg_bot_demos_user ON telegram_bot_demos (telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_bot_demos_day ON telegram_bot_demos (created_at) WHERE mode = 'ai';

-- 3. Одноразовый вход без пароля по ссылке ?tglogin=<код>: 10 минут, хранится хешем,
--    гасится при первом обмене. Ссылка в чате пересылаема — поэтому коротко и один раз.
CREATE TABLE IF NOT EXISTS telegram_login_codes (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_hash        CHAR(64) NOT NULL UNIQUE,
  telegram_user_id BIGINT NOT NULL,
  tenant_id        BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at       TIMESTAMPTZ NOT NULL,
  used_at          TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Пробный период продукта (решение 26.10): 7 дней + 7 бонусных за бота. Только даты:
--    ничего не блокируется, пока нет оплаты. source — откуда пришла организация.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ NULL;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ NULL;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_bonus_days INT NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS source VARCHAR(32) NULL;

-- 5. Заявки из бота: та же таблица, что у сайта, плюс связь с пространством и человеком.
ALTER TABLE landing_leads ADD COLUMN IF NOT EXISTS tenant_id BIGINT NULL REFERENCES tenants(id) ON DELETE SET NULL;
ALTER TABLE landing_leads ADD COLUMN IF NOT EXISTS telegram_user_id BIGINT NULL;
