-- ТЗ-16, волна 4. Глубокая работа: сессия фокуса с таймером от сервера и «постучать срочно».
--
-- Источник правды для таймера — время сервера (п. 48): начало, плановый конец и
-- накопленная пауза. Перезагрузка, второе устройство, свёрнутое приложение — все
-- считают оставшееся от этих же чисел, поэтому таймер не сбрасывается и не расходится.

CREATE TABLE focus_sessions (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id           BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id             BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL,
    focus_day_item_id   BIGINT NULL REFERENCES focus_day_items(id) ON DELETE SET NULL,
    planned_minutes     SMALLINT NOT NULL,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- сдвигается на длину паузы при продолжении: «осталось» = planned_end_at − now()
    planned_end_at      TIMESTAMPTZ NOT NULL,
    paused_at           TIMESTAMPTZ NULL,
    ended_at            TIMESTAMPTZ NULL,
    -- running · paused · completed · cancelled · interrupted
    status              VARCHAR(16) NOT NULL DEFAULT 'running',
    interruptions_count SMALLINT NOT NULL DEFAULT 0,
    -- быстрые заметки по ходу; в конце человек решает, переносить ли их в задачу
    notes               TEXT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Одна идущая сессия на человека: второй фокус поверх первого — это ошибка, а не режим.
CREATE UNIQUE INDEX uq_focus_session_live ON focus_sessions (tenant_id, user_id)
    WHERE status IN ('running', 'paused');
CREATE INDEX idx_focus_sessions_user ON focus_sessions (tenant_id, user_id, started_at DESC);

-- «Постучать срочно» (п. 53–55): журнал и предел — один стук от одного человека
-- одному получателю за одну сессию.
CREATE TABLE focus_knocks (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    session_id    BIGINT NOT NULL REFERENCES focus_sessions(id) ON DELETE CASCADE,
    from_user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason        VARCHAR(200) NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, from_user_id)
);
