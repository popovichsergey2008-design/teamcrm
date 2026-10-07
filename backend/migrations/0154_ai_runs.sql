-- ТЗ-18, этап 1: прогон QEVO Bot из нескольких шагов.
--
-- Раньше один запрос = максимум одно действие: «перенеси встречу и напиши Ивану»
-- бот сделать не мог. Прогон — это одна просьба человека, разложенная на шаги;
-- каждый шаг — обычное действие в ai_tool_actions (с карточкой, правкой и
-- откатом), прогон их только связывает и знает общий статус.

CREATE TABLE ai_runs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    user_id       BIGINT NOT NULL REFERENCES users(id),
    session_id    BIGINT NULL REFERENCES ai_sessions(id) ON DELETE SET NULL,
    -- просьба человека как есть: по ней видно, что он хотел, даже когда шаги разошлись
    intent        TEXT NOT NULL,
    -- queued | running | waiting_confirmation | completed | failed | cancelled
    status        VARCHAR(24) NOT NULL DEFAULT 'waiting_confirmation',
    -- самый высокий риск среди шагов: read | low_write | high_write | destructive
    risk_level    VARCHAR(16) NOT NULL DEFAULT 'low_write',
    steps         INT NOT NULL DEFAULT 0,
    error         TEXT NULL,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ NULL
);
CREATE INDEX idx_ai_runs_user ON ai_runs (tenant_id, user_id, started_at DESC);

ALTER TABLE ai_tool_actions
    ADD COLUMN IF NOT EXISTS run_id     BIGINT NULL REFERENCES ai_runs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS step_no    INT NULL,
    ADD COLUMN IF NOT EXISTS risk_level VARCHAR(16) NULL,
    -- выполнено без нажатия «Создать» (режим AUTO для того, что касается только самого человека)
    ADD COLUMN IF NOT EXISTS auto       BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_ai_tool_actions_run ON ai_tool_actions (run_id) WHERE run_id IS NOT NULL;

-- Уровни автономности по группам действий (ТЗ-18, §4): {"tasks":"confirm","self":"auto",…}.
-- Пусто — значения по умолчанию из tool-policy.ts. Потолок «задевает других → не выше
-- confirm» держит код, а не эта колонка: настройкой его не снять.
ALTER TABLE ai_agent_settings ADD COLUMN IF NOT EXISTS autonomy JSONB NOT NULL DEFAULT '{}'::jsonb;
