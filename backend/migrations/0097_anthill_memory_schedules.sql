-- AnthillBot, MVP 2: персональная память и регулярные задачи агента (ТЗ-6, разд. 15, 20–21, 57–58).
--
-- Память — ОТДЕЛЬНАЯ сущность (разд. 57): не история сообщений и не данные CRM.
-- Причина простая: история стирается вместе с разговором, а «я работаю по
-- Новосибирску» и «сейчас веду Панораму» должны пережить любую уборку. И человек
-- обязан видеть, что о нём запомнили, — поэтому строки короткие и человеческие,
-- а не вектор.
CREATE TABLE ai_memories (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    user_id    BIGINT NOT NULL REFERENCES users(id),
    -- preference — как отвечать и как человек работает; topic — над чем работает сейчас
    type       VARCHAR(16) NOT NULL,
    title      VARCHAR(160) NOT NULL,
    content    VARCHAR(600) NOT NULL,
    -- auto — агент подметил сам, manual — человек попросил запомнить
    source     VARCHAR(16) NOT NULL DEFAULT 'auto',
    session_id BIGINT NULL REFERENCES ai_sessions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Один факт — одна строка: повторное «я работаю по Новосибирску» обновляет, а не плодит.
CREATE UNIQUE INDEX uq_ai_memories_fact ON ai_memories (tenant_id, user_id, type, lower(title));
CREATE INDEX idx_ai_memories_user ON ai_memories (tenant_id, user_id, updated_at DESC);

-- Регулярные задачи (разд. 15, 58): «каждый понедельник в 9:00 — список просроченных».
--
-- Расписание держим разобранным (вид, время, день), а не строкой cron: его нужно
-- показывать человеку по-русски, считать «следующий запуск» в ЕГО поясе и давать
-- править кнопками. Cron ничего из этого не умеет объяснить.
CREATE TABLE ai_scheduled_tasks (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    title       VARCHAR(160) NOT NULL,
    instruction VARCHAR(2000) NOT NULL,
    -- {kind: daily|weekdays|weekly|monthly, time: "09:00", weekday: 1..7, day: 1..28}
    schedule    JSONB NOT NULL,
    -- active | paused | done
    status      VARCHAR(16) NOT NULL DEFAULT 'active',
    next_run_at TIMESTAMPTZ NOT NULL,
    last_run_at TIMESTAMPTZ NULL,
    last_result TEXT NULL,
    last_error  TEXT NULL,
    runs        INT NOT NULL DEFAULT 0,
    -- разговор, в который складываются результаты: у регулярной задачи своя нитка
    session_id  BIGINT NULL REFERENCES ai_sessions(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Планировщик спрашивает только про созревшие и только активные: индекс частичный.
CREATE INDEX idx_ai_sched_due ON ai_scheduled_tasks (next_run_at) WHERE status = 'active';
CREATE INDEX idx_ai_sched_user ON ai_scheduled_tasks (tenant_id, user_id, id DESC);
