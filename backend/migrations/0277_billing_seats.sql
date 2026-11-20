-- #5000 (20.11.2026): оплата за выбранное число пользователей, а не только за текущий состав.
-- Пример: «оплатить 5 человек на 2 месяца», пока в команде четверо, — места для тех, кого ещё
-- пригласят. NULL — старые платежи (за состав на момент оплаты).
ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS seats INT NULL;
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS seats INT NULL;
