-- #4891 «Фокус дня», волна 3 (п. 12): план утром в Telegram / почту / пуш и итоги недели.
-- Время и каналы — у каждого свои, всё можно выключить.
CREATE TABLE IF NOT EXISTS focus_habit_prefs (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plan_on     BOOLEAN NOT NULL DEFAULT TRUE,
    plan_at     VARCHAR(5) NULL,                       -- NULL — начало рабочего дня
    channels    TEXT[] NOT NULL DEFAULT '{telegram,push}', -- telegram | email | push
    week_on     BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- что уже отправлено: план на дату, итоги на неделю — по одному разу
CREATE TABLE IF NOT EXISTS focus_habit_sends (
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind     VARCHAR(8) NOT NULL,                      -- plan | week
    key      DATE NOT NULL,
    sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind, key)
);
