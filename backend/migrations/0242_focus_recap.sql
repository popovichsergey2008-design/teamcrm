-- #4782: после глубокого фокуса — одно сообщение от QEVO Bot (один раз на сессию);
-- звонки во время фокуса не звонят, а попадают в это сообщение пропущенными
ALTER TABLE focus_sessions ADD COLUMN IF NOT EXISTS recap_sent_at TIMESTAMPTZ NULL;
CREATE TABLE IF NOT EXISTS focus_missed_calls (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id   BIGINT      NOT NULL,
  from_user_id BIGINT      NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_focus_missed_calls ON focus_missed_calls (session_id);
