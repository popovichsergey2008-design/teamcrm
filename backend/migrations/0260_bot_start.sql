-- #4893 «Помощь и бот → Новый разговор»: кнопки следующего шага под ответом бота.
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS buttons JSONB NULL;

-- п. 6: «Популярное в вашей компании» — какие сценарии чаще запускают коллеги
CREATE TABLE IF NOT EXISTS bot_scenario_runs (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scenario_id VARCHAR(60) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bot_scenario_runs_tenant ON bot_scenario_runs (tenant_id, created_at);
