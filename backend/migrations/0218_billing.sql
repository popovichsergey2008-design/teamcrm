-- Оплата подписки через ЮKassa (мастер-план релиза, этап 4; решение заказчика 30.10).
--
-- Платит компания помесячно. Новая компания — 14 дней пробного периода без карты
-- (строки подписки у неё может не быть вовсе: срок считается от tenants.created_at).
-- Не оплатили — 3 дня льготы, потом «только чтение». Данные не удаляются никогда.
-- Данные карты к нам не попадают: оплата на странице ЮKassa (redirect).
-- Чеки 54-ФЗ пока не отправляем (заказчик: «пока без чека»).

-- Тарифы. Цены — ЗАГЛУШКИ до решения заказчика; меняются из консоли вендора.
CREATE TABLE billing_plans (
    code         VARCHAR(32) PRIMARY KEY,
    title        VARCHAR(80) NOT NULL,
    price_rub    NUMERIC(12,2) NOT NULL CHECK (price_rub > 0),
    max_members  INT NULL,                 -- NULL — без ограничения
    description  TEXT NOT NULL DEFAULT '',
    sort_order   INT NOT NULL DEFAULT 0,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO billing_plans (code, title, price_rub, max_members, description, sort_order) VALUES
  ('start',    'Старт',   990,  5,   'До 5 сотрудников: задачи, чаты, созвоны, ИИ-секретарь', 1),
  ('team',     'Команда', 2990, 25,  'До 25 сотрудников: всё из «Старта», клиенты, отчёты, разбор встреч', 2),
  ('business', 'Бизнес',  7990, 100, 'До 100 сотрудников: всё из «Команды», приоритетная поддержка', 3);

-- Подписка компании.
CREATE TABLE tenant_subscriptions (
    tenant_id            BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    status               VARCHAR(16) NOT NULL DEFAULT 'TRIAL'
        CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'READ_ONLY', 'CANCELLED')),
    plan_code            VARCHAR(32) NULL REFERENCES billing_plans(code),
    trial_ends_at        TIMESTAMPTZ NULL,
    current_period_end   TIMESTAMPTZ NULL,
    -- без оплаты: «вечный» доступ (компании, работавшие до оплаты, и свои)
    complimentary        BOOLEAN NOT NULL DEFAULT FALSE,
    -- сохранённый способ оплаты ЮKassa для автопродления (если магазину разрешено)
    payment_method_id    VARCHAR(64) NULL,
    autopay              BOOLEAN NOT NULL DEFAULT FALSE,
    -- о чём уже сказали владельцу (trial_3d, trial_1d, grace, read_only, renew_3d…) — чтобы не повторять
    notified             JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Все, кто уже работает в системе, остаются без ограничений: решать о них будет вендор.
INSERT INTO tenant_subscriptions (tenant_id, status, complimentary)
SELECT id, 'ACTIVE', TRUE FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- Платежи.
CREATE TABLE billing_payments (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id          BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider_payment_id VARCHAR(64) NULL UNIQUE,  -- id платежа в ЮKassa
    plan_code          VARCHAR(32) NOT NULL REFERENCES billing_plans(code),
    amount_rub         NUMERIC(12,2) NOT NULL,
    status             VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'succeeded', 'canceled', 'refunded')),
    kind               VARCHAR(16) NOT NULL DEFAULT 'checkout' CHECK (kind IN ('checkout', 'autopay')),
    created_by         BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    cancel_reason      TEXT NULL,
    paid_at            TIMESTAMPTZ NULL,
    period_end         TIMESTAMPTZ NULL,           -- до какого числа продлило
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_payments_tenant ON billing_payments (tenant_id, created_at DESC);

-- Уведомления ЮKassa: одно и то же может прийти несколько раз — обрабатываем один.
CREATE TABLE billing_webhook_events (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_event_id VARCHAR(160) NOT NULL UNIQUE,   -- «событие:id платежа»
    event             VARCHAR(64) NOT NULL,
    payload           JSONB NOT NULL,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at      TIMESTAMPTZ NULL,
    error             TEXT NULL
);
