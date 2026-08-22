-- Журнал автоматических действий («AI Секретарь»).
--
-- Система уже делает за людей заметную работу: раскладывает задачи со встреч,
-- собирает стендапы, поднимает черновики из писем, выполняет задачи агентом.
-- Всё это происходит молча, и человек не видит, что именно ему сэкономили.
-- Виджет в панели показывает это число — но показывать его можно только тогда,
-- когда есть, что показать: без журнала счётчик пришлось бы выдумывать.
--
-- Здесь только факты: что сделано, к чему относится и сколько минут ручной
-- работы это заменило. Оценка минут — грубая и одинаковая для типа действия
-- (см. SAVED_MINUTES в коде): честнее круглая цифра рядом с описанием действия,
-- чем точная на вид, но взятая с потолка.
CREATE TABLE ai_actions (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    -- Кому засчитана экономия. NULL — действие в пользу всей компании
    -- (например, ночная синхронизация), такие видны всем в общем журнале.
    user_id       BIGINT NULL REFERENCES users(id),
    kind          VARCHAR(32) NOT NULL,   -- meeting_task | meeting_summary | standup | agent_run | inbox_draft | nl_task
    subject_type  VARCHAR(16) NULL,       -- task | meeting | project
    subject_id    BIGINT NULL,            -- без внешнего ключа: сущность может быть удалена, а запись в журнале остаётся
    summary       VARCHAR(300) NOT NULL,  -- человеческая строка для ленты
    saved_minutes INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Лента и счётчик за сегодня — обе выборки по организации и времени.
CREATE INDEX idx_ai_actions_feed ON ai_actions (tenant_id, created_at DESC);
