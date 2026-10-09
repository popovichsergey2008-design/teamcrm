-- ТЗ-19 «Пульс команды» как командный центр руководителя.

-- Срок проекта (решение 09.10): без плановой даты прогноз мог сказать только «закончим
-- примерно к …», а не «опаздываем на 3 дня». Вехи — позже.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS target_date DATE NULL;

-- Норма нагрузки человека в очках (решение 09.10): оценок времени у задач нет, поэтому
-- загрузка считается в очках, а 100% — личная норма. NULL — 12 очков по умолчанию.
ALTER TABLE users ADD COLUMN IF NOT EXISTS load_norm_points INT NULL;

-- Действия из «Пульса»: предложение → предпросмотр → подтверждение → выполнение (§47–49).
CREATE TABLE radar_action_proposals (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    actor_user_id BIGINT NOT NULL REFERENCES users(id),
    -- bottleneck | decision | workload | forecast | victory
    source_type   VARCHAR(16) NOT NULL,
    source_id     VARCHAR(64) NULL,
    -- TASK_NUDGE | TASK_REASSIGN | TASK_RESCHEDULE | TASK_CREATE_MEETING | REVIEW_REMINDER | PUBLISH_NEWS | REBALANCE
    action_type   VARCHAR(24) NOT NULL,
    payload_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
    preview       TEXT NOT NULL,
    reason        TEXT NULL,
    -- proposed | executing | completed | failed | rejected | expired
    status        VARCHAR(16) NOT NULL DEFAULT 'proposed',
    error         TEXT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at  TIMESTAMPTZ NULL,
    executed_at   TIMESTAMPTZ NULL
);
CREATE INDEX idx_radar_actions_tenant ON radar_action_proposals (tenant_id, created_at DESC);

-- Мягкий push (§27): пауза между вопросами по одной задаче — не дёргаем человека
-- каждый раз, когда руководитель открыл экран.
CREATE TABLE radar_nudges (
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    task_id    BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_by    BIGINT NULL REFERENCES users(id),
    PRIMARY KEY (task_id, sent_at)
);
CREATE INDEX idx_radar_nudges_task ON radar_nudges (task_id, sent_at DESC);

-- «Это не проблема» (§72): отмеченное не показываем неделю; причины — для настройки правил.
CREATE TABLE radar_feedback (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    user_id    BIGINT NOT NULL REFERENCES users(id),
    -- bottleneck | decision | workload | forecast | project
    kind       VARCHAR(16) NOT NULL,
    ref        VARCHAR(64) NOT NULL,
    reason     VARCHAR(24) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_radar_feedback_ref ON radar_feedback (tenant_id, kind, ref, created_at DESC);

-- История прогнозов по проекту (§75): раз в сутки — что предсказали; когда проект
-- закрылся — насколько ошиблись.
CREATE TABLE radar_forecasts (
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
    project_id      BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    day             DATE NOT NULL,
    plan_date       DATE NULL,
    predicted_date  DATE NULL,
    confidence      INT NOT NULL DEFAULT 0,
    remaining       INT NOT NULL DEFAULT 0,
    version         VARCHAR(16) NOT NULL,
    PRIMARY KEY (project_id, day)
);
