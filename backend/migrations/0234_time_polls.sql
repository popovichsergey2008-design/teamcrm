-- #4787 (ТЗ календаря, п. 15): опрос времени для встречи с внешними людьми.
--
-- Организатор предлагает несколько вариантов, гости по ссылке отмечают «Подходит ·
-- Возможно · Не подходит», организатор выбирает итог — создаётся встреча (с повторной
-- проверкой, не занялось ли время), голосовавшие с почтой приглашаются гостями.
CREATE TABLE time_polls (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    user_id       BIGINT NOT NULL REFERENCES users(id),
    title         VARCHAR(255) NOT NULL,
    duration_min  INT NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
    slug          VARCHAR(40) NOT NULL UNIQUE,
    participant_ids BIGINT[] NOT NULL DEFAULT '{}',
    status        VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'decided', 'closed')),
    event_id      BIGINT NULL REFERENCES calendar_events(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_time_polls_user ON time_polls (tenant_id, user_id, created_at DESC);

CREATE TABLE time_poll_options (
    id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    poll_id   BIGINT NOT NULL REFERENCES time_polls(id) ON DELETE CASCADE,
    starts_at TIMESTAMPTZ NOT NULL,
    UNIQUE (poll_id, starts_at)
);

CREATE TABLE time_poll_votes (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    poll_id     BIGINT NOT NULL REFERENCES time_polls(id) ON DELETE CASCADE,
    voter_key   VARCHAR(64) NOT NULL,            -- кто голосовал: почта или имя (повторный голос заменяет прежний)
    voter_name  VARCHAR(120) NOT NULL,
    voter_email VARCHAR(320) NULL,
    answers     JSONB NOT NULL,                  -- {"<option_id>": "yes" | "maybe" | "no"}
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (poll_id, voter_key)
);
