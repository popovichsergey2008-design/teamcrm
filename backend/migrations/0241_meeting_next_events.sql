-- #4779, п. 5: на встрече договорились о следующей — ИИ ПРЕДЛАГАЕТ событие на экране итогов,
-- в календарь (и Google) оно попадает после подтверждения
CREATE TABLE IF NOT EXISTS meeting_next_events (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  meeting_id       BIGINT       NOT NULL,
  title            VARCHAR(255) NOT NULL,
  starts_at        TIMESTAMPTZ  NOT NULL,
  ends_at          TIMESTAMPTZ  NOT NULL,
  organizer_id     BIGINT       NULL,
  participant_ids  BIGINT[]     NOT NULL DEFAULT '{}',
  quote            TEXT         NULL,
  status           VARCHAR(12)  NOT NULL DEFAULT 'pending',
  event_id         BIGINT       NULL,
  decided_by       BIGINT       NULL,
  decided_at       TIMESTAMPTZ  NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meeting_next_events ON meeting_next_events (tenant_id, meeting_id);
