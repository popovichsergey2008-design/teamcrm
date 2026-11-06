-- #4787 (ТЗ календаря, п. 6–9): запись по ссылке, как в Calendly.
--
-- booking_types   — готовые виды встреч человека (п. 7): «Знакомство — 15 минут» и т.д.
--                   Ссылка записи — по slug вида (случайная строка, не номер: перебором не найти).
-- booking_rules   — когда человек вообще принимает встречи (п. 8): часы по дням недели с
--                   перерывами, закрытые даты, отпуск, лимит в день, «не в последний момент»,
--                   как далеко вперёд.
-- bookings        — сами записи гостей (п. 6, 9): встреча организатора + гость + токен
--                   управления (перенести / отменить без переписки).

CREATE TABLE booking_types (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    user_id       BIGINT NOT NULL REFERENCES users(id),
    slug          VARCHAR(40) NOT NULL UNIQUE,
    title         VARCHAR(160) NOT NULL,
    description   VARCHAR(1000) NULL,
    duration_min  INT NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
    -- свои дни и часы вида (п. 7: «только вторник и четверг, с 11 до 16»); пусто — общие правила
    -- формат: {"1":[["11:00","16:00"]],"4":[["11:00","16:00"]]}, ключ — день недели (0 = вс)
    weekly        JSONB NULL,
    -- место или способ: call — наш созвон; place — адрес; phone — телефон
    location_kind VARCHAR(8) NOT NULL DEFAULT 'call' CHECK (location_kind IN ('call', 'place', 'phone')),
    location      VARCHAR(255) NULL,
    buffer_before INT NOT NULL DEFAULT 0 CHECK (buffer_before BETWEEN 0 AND 240),
    buffer_after  INT NOT NULL DEFAULT 0 CHECK (buffer_after BETWEEN 0 AND 240),
    -- вопросы гостю перед записью: [{"text":"Что вы хотите обсудить?","required":true}]
    questions     JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- напоминания организатору, минут до начала
    reminders     INT[] NOT NULL DEFAULT '{15}',
    position      INT NOT NULL DEFAULT 0,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_booking_types_user ON booking_types (tenant_id, user_id, position);

CREATE TABLE booking_rules (
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
    user_id         BIGINT NOT NULL REFERENCES users(id) PRIMARY KEY,
    -- часы для встреч по дням недели, с перерывами: {"1":[["09:00","13:00"],["14:00","18:00"]],…}
    weekly          JSONB NOT NULL,
    blocked_dates   DATE[] NOT NULL DEFAULT '{}',
    -- отпуск: [{"from":"2026-12-28","to":"2027-01-08"}]
    vacations       JSONB NOT NULL DEFAULT '[]'::jsonb,
    max_per_day     INT NULL CHECK (max_per_day IS NULL OR max_per_day BETWEEN 1 AND 50),
    min_notice_min  INT NOT NULL DEFAULT 180 CHECK (min_notice_min BETWEEN 0 AND 20160),
    horizon_days    INT NOT NULL DEFAULT 14 CHECK (horizon_days BETWEEN 1 AND 365),
    timezone        VARCHAR(64) NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bookings (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    type_id       BIGINT NOT NULL REFERENCES booking_types(id),
    user_id       BIGINT NOT NULL REFERENCES users(id),
    event_id      BIGINT NULL REFERENCES calendar_events(id) ON DELETE SET NULL,
    guest_name    VARCHAR(120) NOT NULL,
    guest_email   VARCHAR(320) NOT NULL,
    guest_tz      VARCHAR(64) NULL,
    answers       JSONB NOT NULL DEFAULT '[]'::jsonb,
    starts_at     TIMESTAMPTZ NOT NULL,
    ends_at       TIMESTAMPTZ NOT NULL,
    status        VARCHAR(12) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
    manage_hash   VARCHAR(64) NOT NULL UNIQUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at  TIMESTAMPTZ NULL
);
-- два гостя на один и тот же слот одного человека: подтверждение получает только один (п. 6)
CREATE UNIQUE INDEX uq_bookings_slot ON bookings (user_id, starts_at) WHERE status = 'confirmed';
CREATE INDEX idx_bookings_user ON bookings (tenant_id, user_id, starts_at);
