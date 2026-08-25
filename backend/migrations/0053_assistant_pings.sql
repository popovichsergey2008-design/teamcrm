-- Смарт-пинги AI Секретаря: напоминания, которые сейчас раздаёт руководитель руками.
--
-- «Что со статусом?», «срок вчера», «сдано три дня назад и висит на проверке» —
-- это не управление, а обход по кругу. Ассистент видит то же самое в данных и
-- может напомнить сам.
--
-- Пинг — не уведомление: у него есть жизнь. Он появляется по поводу, живёт, пока
-- повод не исчерпан, и закрывается — человеком («скрыть») или самим фактом
-- (задачу закрыли, срок сдвинули).
CREATE TABLE assistant_pings (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    -- Кому напоминаем.
    user_id     BIGINT NOT NULL REFERENCES users(id),
    -- overdue | due_soon | stuck_review | silent
    kind        VARCHAR(24) NOT NULL,
    task_id     BIGINT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    text        VARCHAR(300) NOT NULL,
    -- proposed — ассистент предлагает напомнить и ждёт человека (режим «копилот»);
    -- sent — напоминание доставлено; dismissed — человек его закрыл.
    status      VARCHAR(12) NOT NULL DEFAULT 'sent',
    /**
     * Ключ повтора: один и тот же повод по одной задаче — не чаще раза в сутки.
     * Без него планировщик, который ходит каждые несколько минут, за день
     * превратил бы напоминание в травлю.
     */
    dedup_key   VARCHAR(120) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX idx_assistant_pings_dedup ON assistant_pings (tenant_id, dedup_key);
CREATE INDEX idx_assistant_pings_user ON assistant_pings (tenant_id, user_id, status, created_at DESC);

-- Режим автономности ассистента. По умолчанию «копилот»: система, которая начинает
-- сама писать людям сразу после обновления, — плохой сосед. Владелец включает
-- автопилот, когда увидит, о чём именно ассистент собирается напоминать.
ALTER TABLE tenants
    ADD COLUMN assistant_mode VARCHAR(10) NOT NULL DEFAULT 'copilot';
