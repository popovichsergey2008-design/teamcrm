-- Календарь: события, участники и рабочее время организации.
--
-- Два вида календаря по решению заказчика: личный у каждого и общий календарь компании.
-- Календарей проектов пока нет намеренно — см. specs/tz2-06-calendar-step1.md.
CREATE TABLE calendar_events (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    -- personal — событие человека (видят участники), company — общее (видят все в организации)
    scope        VARCHAR(16) NOT NULL DEFAULT 'personal',
    owner_id     BIGINT NOT NULL REFERENCES users(id),
    title        VARCHAR(255) NOT NULL,
    description  TEXT NULL,
    location     VARCHAR(255) NULL,
    -- Наш созвон: id комнаты, куда ведёт кнопка «Начать созвон». Не ссылка на внешний сервис:
    -- у нас своя комната, и внешнего гостя туда пускает гостевая ссылка (этап 4).
    meet_room_id VARCHAR(64) NULL,
    starts_at    TIMESTAMPTZ NOT NULL,
    ends_at      TIMESTAMPTZ NOT NULL,
    all_day      BOOLEAN NOT NULL DEFAULT FALSE,
    color        VARCHAR(16) NULL,
    -- Приватное событие другие видят как «Занято» без названия и описания
    is_private   BOOLEAN NOT NULL DEFAULT FALSE,
    created_by   BIGINT NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at >= starts_at),
    CHECK (scope IN ('personal', 'company'))
);

-- Выборка всегда одна и та же: что попадает в видимый промежуток времени.
CREATE INDEX idx_calendar_events_range ON calendar_events (tenant_id, starts_at, ends_at);

-- Участники отдельной таблицей, а не массивом в событии: у каждого свой ответ на приглашение,
-- и менять его нужно по одному человеку, не переписывая событие целиком.
CREATE TABLE calendar_participants (
    event_id     BIGINT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    user_id      BIGINT NOT NULL REFERENCES users(id),
    status       VARCHAR(16) NOT NULL DEFAULT 'invited',  -- invited | accepted | declined
    is_organizer BOOLEAN NOT NULL DEFAULT FALSE,
    responded_at TIMESTAMPTZ NULL,
    PRIMARY KEY (event_id, user_id),
    CHECK (status IN ('invited', 'accepted', 'declined'))
);
CREATE INDEX idx_calendar_participants_user ON calendar_participants (tenant_id, user_id, status);

-- Рабочее время организации: одна строка на компанию. Задаёт владелец (или его помощник —
-- второй владелец). Нерабочие часы и выходные в сетке приглушены, но события в них ставить
-- можно: запрет тут был бы вредным — люди работают и в субботу, когда горит.
CREATE TABLE org_work_settings (
    tenant_id    BIGINT PRIMARY KEY REFERENCES tenants(id),
    work_start   TIME NOT NULL DEFAULT '09:00',
    work_end     TIME NOT NULL DEFAULT '18:00',
    weekend_days INT[] NOT NULL DEFAULT '{0,6}',  -- 0=воскресенье … 6=суббота
    holidays     DATE[] NOT NULL DEFAULT '{}',
    updated_by   BIGINT NULL REFERENCES users(id),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
