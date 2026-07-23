-- Библиотека промптов агента: сотрудник пишет свои промпты-пресеты (роль/стиль/структура)
-- под разные задачи и применяет их в задаче, выбирая модель. Личные или общие (командные).
CREATE TABLE agent_prompts (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    created_by  BIGINT NOT NULL REFERENCES users(id),
    name        VARCHAR(120) NOT NULL,
    instruction TEXT NOT NULL,
    model       VARCHAR(80) NULL,                    -- выбранная модель ИИ или NULL = по умолчанию
    is_shared   BOOLEAN NOT NULL DEFAULT FALSE,      -- личный (только автор) | общий (вся команда)
    usage_count INT NOT NULL DEFAULT 0,              -- наработка: популярные — наверх
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_prompts_tenant ON agent_prompts (tenant_id, created_by);
