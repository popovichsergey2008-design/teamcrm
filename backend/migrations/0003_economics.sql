-- TEAMCRM Этап 2 — Real-Time Unit-Economics: таймер, P&L-агрегаты, алерты.

-- Один активный таймер на пользователя (Шаг 2.1) — гарантия на уровне БД.
CREATE UNIQUE INDEX uq_open_timer_per_user
    ON time_logs (tenant_id, user_id)
    WHERE timestamp_end IS NULL;

-- Денормализованные агрегаты P&L проекта (пишет ТОЛЬКО движок economics).
ALTER TABLE projects
    ADD COLUMN cost_actual            NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN margin_actual          NUMERIC(6,2)  NULL,   -- %, NULL если бюджет не задан
    ADD COLUMN margin_alert_threshold NUMERIC(5,2)  NULL,   -- NULL = брать из tenant
    ADD COLUMN economics_recomputed_at TIMESTAMPTZ  NULL;

-- Порог маржи по умолчанию на уровне арендатора.
ALTER TABLE tenants
    ADD COLUMN default_margin_threshold NUMERIC(5,2) NOT NULL DEFAULT 20.00;

-- Алерты (проактивный контроль; на Этапе 4 расширяются риском срыва).
CREATE TABLE alerts (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    project_id  BIGINT NULL REFERENCES projects(id),
    task_id     BIGINT NULL REFERENCES tasks(id),
    type        VARCHAR(48) NOT NULL,           -- margin_below_threshold | ...
    severity    VARCHAR(16) NOT NULL DEFAULT 'warning',
    payload     JSONB NOT NULL,                 -- {budget, cost, margin, threshold}
    raised_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ NULL                -- NULL = активен
);
-- Не более одного активного алерта данного типа на проект (idempotent raise).
CREATE UNIQUE INDEX uq_active_alert_per_project_type
    ON alerts (tenant_id, project_id, type)
    WHERE resolved_at IS NULL;
CREATE INDEX idx_alerts_active ON alerts (tenant_id, resolved_at);

-- Индекс для поиска открытых таймеров (догоняющий тик пересчёта).
CREATE INDEX idx_time_logs_open ON time_logs (tenant_id, task_id)
    WHERE timestamp_end IS NULL;
