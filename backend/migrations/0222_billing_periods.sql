-- Тарифы помесячно и на год, версии цен (ТЗ консолей, §5.4).
--
-- Годовая цена — отдельная полная сумма за год, не «месяц × 12»: скидку за год задаёт
-- владелец. Каждое изменение тарифа — новая версия; действующие подписки помнят свою
-- цену и период и продлеваются по ним — смена прайса их молча не меняет.

ALTER TABLE billing_plans ADD COLUMN price_year_rub NUMERIC(12,2);
ALTER TABLE billing_plans ADD COLUMN version INT NOT NULL DEFAULT 1;

CREATE TABLE billing_plan_versions (
  id               BIGSERIAL PRIMARY KEY,
  plan_code        VARCHAR(32) NOT NULL REFERENCES billing_plans(code) ON DELETE CASCADE,
  version          INT NOT NULL,
  title            VARCHAR(120) NOT NULL,
  price_month_rub  NUMERIC(12,2) NOT NULL,
  price_year_rub   NUMERIC(12,2),
  max_members      INT,
  description      TEXT NOT NULL DEFAULT '',
  is_active        BOOLEAN NOT NULL,
  changed_by       VARCHAR(255),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (plan_code, version)
);
INSERT INTO billing_plan_versions (plan_code, version, title, price_month_rub, price_year_rub, max_members, description, is_active, changed_by)
SELECT code, 1, title, price_rub, NULL, max_members, description, is_active, 'миграция' FROM billing_plans;

-- Подписка помнит, за что платили: период и цену продления.
ALTER TABLE tenant_subscriptions ADD COLUMN period_months INT NOT NULL DEFAULT 1;
ALTER TABLE tenant_subscriptions ADD COLUMN price_rub NUMERIC(12,2);
ALTER TABLE tenant_subscriptions ADD COLUMN plan_version INT;

-- Платёж: период, версия цены и тестовый ли он (ЮKassa отвечает test=true у тестового магазина).
ALTER TABLE billing_payments ADD COLUMN period_months INT NOT NULL DEFAULT 1;
ALTER TABLE billing_payments ADD COLUMN plan_version INT;
ALTER TABLE billing_payments ADD COLUMN is_test BOOLEAN NOT NULL DEFAULT false;
