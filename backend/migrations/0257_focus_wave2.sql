-- #4891 «Фокус дня», волна 2 (п. 7–11).

-- п. 7: принятый пересмотр плана — чтобы «Вернуть как было» в течение дня
CREATE TABLE IF NOT EXISTS focus_replans (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    focus_date  DATE NOT NULL,
    item_key    VARCHAR(80) NOT NULL,
    title       VARCHAR(255) NOT NULL,
    block_id    BIGINT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reverted_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_focus_replans_user ON focus_replans (user_id, focus_date);

-- п. 8: «Это не обещание» — фраза уходит из брифа и учит фильтр компании
CREATE TABLE IF NOT EXISTS focus_not_promises (
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    phrase     VARCHAR(300) NOT NULL,
    user_id    BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, phrase)
);

-- п. 10: «Завтра начните с…» — первая строка брифа следующего рабочего дня
CREATE TABLE IF NOT EXISTS focus_start_with (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    focus_date DATE NOT NULL,
    text       VARCHAR(500) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, focus_date)
);

-- п. 10: мягкое напоминание «Завершить день» — одно в день
ALTER TABLE focus_day_plans ADD COLUMN IF NOT EXISTS close_reminded_at TIMESTAMPTZ NULL;
