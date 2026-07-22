-- Оркестрация ИИ-агентов: журнал запусков. Агент по задаче предлагает черновик решения
-- (в комментарий, human-in-the-loop). Здесь — статус/результат/стоимость каждого запуска.
CREATE TABLE agent_runs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    task_id       BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind          VARCHAR(32) NOT NULL DEFAULT 'task_draft',  -- пока один тип: черновик решения задачи
    status        VARCHAR(16) NOT NULL DEFAULT 'running',     -- running | done | failed
    result        TEXT NULL,                                  -- предложенный черновик
    comment_id    BIGINT NULL,                                -- комментарий-черновик, куда положен результат
    citations     JSONB NULL,                                 -- источники из базы знаний
    input_tokens  INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    error         TEXT NULL,
    created_by    BIGINT NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ NULL
);
CREATE INDEX idx_agent_runs_task ON agent_runs (tenant_id, task_id);
CREATE INDEX idx_agent_runs_recent ON agent_runs (tenant_id, created_at);
