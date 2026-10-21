-- Дорожки созвона по людям (21.10): кто говорил и с какой секунды созвона началась
-- его дорожка. Без этого «Повторить» после сбоя расшифровывал только сведённую
-- запись — стенограмма без имён говорящих. С этим повтор идёт так же, как первый проход.
CREATE TABLE IF NOT EXISTS meeting_tracks (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
  meeting_id  BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  file_id     BIGINT NOT NULL REFERENCES files(id),
  -- NULL — гость: сотрудником он не является
  user_id     BIGINT NULL REFERENCES users(id),
  speaker     VARCHAR(255) NOT NULL,
  offset_sec  NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meeting_tracks_meeting ON meeting_tracks (meeting_id);
