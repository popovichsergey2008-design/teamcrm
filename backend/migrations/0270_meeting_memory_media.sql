-- #4902, п. 12 и п. 14.
--
-- п. 14 «Видео и голос → текст и задачи»: разбор клипа чата (голосовое, запись экрана).
-- Текст целиком по-прежнему лежит в chat_messages.transcript — на нём поиск, сводки и
-- «палочка». Здесь то, чего там нет: реплики с метками времени (сегменты Whisper),
-- «кратко» в 1–2 строки, отметки «0:42 баг» и задача-баг, созданная из записи.
CREATE TABLE IF NOT EXISTS chat_clip_insights (
    message_id    BIGINT PRIMARY KEY REFERENCES chat_messages(id) ON DELETE CASCADE,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    chat_id       BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    kind          VARCHAR(8) NOT NULL,                     -- voice | screen
    status        VARCHAR(12) NOT NULL DEFAULT 'running',  -- running | ready | failed
    segments      JSONB NOT NULL DEFAULT '[]'::jsonb,      -- [{start, end, text}]
    summary       TEXT NULL,
    summary_by    VARCHAR(8) NULL,                         -- model | rules
    marks         JSONB NOT NULL DEFAULT '[]'::jsonb,      -- [{sec, label, kind}]
    duration_sec  NUMERIC(10,2) NULL,
    -- от загрузки записи до готового текста: «готово, когда ≤ 30 с для записи до 5 минут»
    ready_ms      INT NULL,
    bug_task_id   BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_clip_insights_chat ON chat_clip_insights (tenant_id, chat_id);

-- п. 12 «Кратко до сих пор»: что пересказали опоздавшему и по каким моментам записи.
-- Секунды — от начала записи созвона, как у стенограммы встречи: после разбора тот же
-- момент открывается ссылкой /meetings/:id?t=…  Журнал нужен и для этой ссылки, и для
-- проверки «пересказ ссылается на моменты записи».
CREATE TABLE IF NOT EXISTS meeting_live_recaps (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    room_id       VARCHAR(64) NOT NULL,
    requested_by  BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    source        VARCHAR(12) NOT NULL,                    -- model | rules | empty
    points        JSONB NOT NULL DEFAULT '[]'::jsonb,      -- [{sec, at, speaker, text}]
    recording_started_at TIMESTAMPTZ NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meeting_live_recaps_room ON meeting_live_recaps (tenant_id, room_id, created_at DESC);
