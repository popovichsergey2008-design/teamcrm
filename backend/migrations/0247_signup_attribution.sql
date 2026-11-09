-- #4804: откуда пришёл человек при ПЕРВОЙ регистрации — для недельного отчёта по площадкам.
-- Одна строка на аккаунт и больше не переписывается (ON CONFLICT DO NOTHING в коде).
-- Только метки кампании и домен источника: ни IP, ни браузера здесь нет.
CREATE TABLE IF NOT EXISTS signup_attribution (
  account_id           BIGINT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  tenant_id            BIGINT REFERENCES tenants(id) ON DELETE SET NULL,
  user_id              BIGINT REFERENCES users(id) ON DELETE SET NULL,
  signup_utm_source    VARCHAR(200) NOT NULL DEFAULT 'direct',
  signup_utm_medium    VARCHAR(200),
  signup_utm_campaign  VARCHAR(200),
  signup_utm_content   VARCHAR(200),
  signup_referrer_host VARCHAR(253),
  signup_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signup_attribution_at ON signup_attribution (signup_at);
