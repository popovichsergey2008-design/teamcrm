-- ТЗ 10.11: один тариф «QEVO» как на сайте — 449 ₽ за пользователя в месяц, 399 ₽ при
-- оплате за год (полная годовая цена за пользователя — 4 788 ₽). Старые «Старт / Команда /
-- Бизнес» скрываются: платежей по ним не было, подписки (если появятся) помнят свою цену.
ALTER TABLE billing_plans ADD COLUMN IF NOT EXISTS per_member BOOLEAN NOT NULL DEFAULT false;

INSERT INTO billing_plans (code, title, price_rub, price_year_rub, max_members, description, sort_order, is_active, version, per_member)
VALUES ('qevo', 'QEVO', 449, 4788, NULL,
        'Мессенджер, созвоны, задачи, ИИ (1 000 000 токенов в месяц на пространство) и служба заботы. Все функции в одном тарифе.',
        0, true, 1, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO billing_plan_versions (plan_code, version, title, price_month_rub, price_year_rub, max_members, description, is_active, changed_by)
SELECT code, version, title, price_rub, price_year_rub, max_members, description, is_active, 'миграция 0250'
  FROM billing_plans WHERE code = 'qevo'
ON CONFLICT (plan_code, version) DO NOTHING;

UPDATE billing_plans SET is_active = false, updated_at = now() WHERE code IN ('start', 'team', 'business');
