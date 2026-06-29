-- TEAMCRM Этап 4 — AI Load Balancer, предиктивные сроки, co-pilot.

-- Метрики Velocity (детерминированный пересчёт из time_logs за окно).
CREATE TABLE velocity_metrics (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    user_id       BIGINT NOT NULL REFERENCES users(id),
    window_from   TIMESTAMPTZ NOT NULL,
    window_to     TIMESTAMPTZ NOT NULL,
    closed_tasks  INT NOT NULL,
    tracked_hours NUMERIC(12,2) NOT NULL,
    velocity      NUMERIC(10,4) NOT NULL,        -- закрытые задачи / время
    computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, user_id, window_from, window_to)
);
CREATE INDEX idx_velocity_user ON velocity_metrics (tenant_id, user_id, computed_at);

-- Доступность/отсутствия сотрудника (отпуск, больничный) — влияет на ёмкость.
CREATE TABLE user_availability (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    kind        VARCHAR(24) NOT NULL,            -- vacation | sick | other
    from_date   DATE NOT NULL,
    to_date     DATE NOT NULL
);
CREATE INDEX idx_availability_user ON user_availability (tenant_id, user_id, from_date);

-- Плановая недельная ёмкость сотрудника (часов).
ALTER TABLE users
    ADD COLUMN weekly_capacity_hours NUMERIC(6,2) NOT NULL DEFAULT 40.00;

-- Поля задачи под прогноз и светофор.
ALTER TABLE tasks
    ADD COLUMN estimate_hours      NUMERIC(8,2) NULL,
    ADD COLUMN deadline_at         TIMESTAMPTZ  NULL,
    ADD COLUMN predicted_finish_at TIMESTAMPTZ  NULL,   -- пишет только forecast
    ADD COLUMN risk_pct            NUMERIC(5,2) NULL,   -- 0..100, internal
    ADD COLUMN risk_level          VARCHAR(8)   NULL;   -- green | yellow | red

-- Порог риска перегруза/срыва на уровне арендатора.
ALTER TABLE tenants
    ADD COLUMN risk_alert_threshold NUMERIC(5,2) NOT NULL DEFAULT 75.00;

-- Проактивные рекомендации co-pilot.
CREATE TABLE recommendations (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    type        VARCHAR(32) NOT NULL,            -- reassign | deal_at_risk | draft_client_update
    project_id  BIGINT NULL REFERENCES projects(id),
    task_id     BIGINT NULL REFERENCES tasks(id),
    is_financial BOOLEAN NOT NULL DEFAULT FALSE, -- true → только internal-роли
    payload     JSONB NOT NULL,
    status      VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending | accepted | dismissed
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ NULL
);
CREATE INDEX idx_recommendations_status ON recommendations (tenant_id, status, type);

-- Аудит подтверждённых перегрузов (жёсткое предупреждение продавлено человеком).
CREATE TABLE assignment_audit (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    task_id      BIGINT NOT NULL REFERENCES tasks(id),
    assignee_id  BIGINT NOT NULL REFERENCES users(id),
    actor_id     BIGINT NOT NULL REFERENCES users(id),
    risk_pct     NUMERIC(5,2) NULL,
    overload_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_assignment_audit_task ON assignment_audit (tenant_id, task_id);
