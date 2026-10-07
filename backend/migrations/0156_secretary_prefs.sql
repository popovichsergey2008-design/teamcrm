-- ТЗ-18, этап 2 и 4: личные настройки секретаря.
--
-- Утренняя сводка и итоги дня — каждому в своё время и в свой канал (§10.3, §10.4,
-- §19.3). По умолчанию выключены: секретарь, который сам начинает писать всем,
-- повторяет ошибку августа (190 напоминаний за 4 дня при реакции 14 «скрыть»).
-- Человек включает сам — и знает, откуда пришло.

CREATE TABLE secretary_prefs (
    user_id            BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tenant_id          BIGINT NOT NULL REFERENCES tenants(id),
    morning_at         TIME NULL,              -- NULL — утренней сводки нет
    evening_at         TIME NULL,              -- NULL — итогов дня нет
    weekdays_only      BOOLEAN NOT NULL DEFAULT true,
    -- куда слать сверх ящика в приложении: {"push":true,"telegram":true}
    channels           JSONB NOT NULL DEFAULT '{"push":true,"telegram":true}'::jsonb,
    -- справка перед встречей за N минут (этап 3); NULL — не нужна
    meeting_brief_min  INT NULL,
    -- важные люди: их сообщения и встречи с ними — первыми (§8.1, §9)
    vip_user_ids       BIGINT[] NOT NULL DEFAULT '{}',
    last_morning       DATE NULL,
    last_evening       DATE NULL,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_secretary_prefs_on ON secretary_prefs (tenant_id)
    WHERE morning_at IS NOT NULL OR evening_at IS NOT NULL OR meeting_brief_min IS NOT NULL;
