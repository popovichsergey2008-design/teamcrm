-- Этап 6, М2 — разбор записей встреч: запись → стенограмма → сводка → черновики задач.
-- Своих созвонов ещё нет: сюда загружают файл из Meet/Zoom/диктофона либо готовую
-- стенограмму (.vtt/.srt), где говорящие уже размечены платформой.

CREATE TABLE meetings (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    project_id   BIGINT NULL REFERENCES projects(id),  -- проект по умолчанию для задач встречи
    title        VARCHAR(255) NOT NULL,
    happened_at  TIMESTAMPTZ NULL,                     -- когда встреча реально была
    source       VARCHAR(16) NOT NULL,                 -- audio | transcript
    file_id      BIGINT NULL REFERENCES files(id),     -- исходная запись в MinIO
    duration_sec INT NULL,
    -- queued → transcribing → analyzing → done | error
    status       VARCHAR(16) NOT NULL DEFAULT 'queued',
    error        TEXT NULL,
    created_by   BIGINT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_meetings_tenant ON meetings (tenant_id, created_at DESC);

-- Стенограмма: реплики с таймкодами. Для смешанной дорожки говорящий неизвестен
-- (speaker NULL) — имена появятся, когда будут свои созвоны с дорожкой на участника.
CREATE TABLE meeting_segments (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
    meeting_id      BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    idx             INT NOT NULL,
    start_sec       NUMERIC(10,2) NOT NULL,
    end_sec         NUMERIC(10,2) NULL,
    speaker         VARCHAR(120) NULL,                 -- как назвала платформа (из .vtt)
    speaker_user_id BIGINT NULL REFERENCES users(id),  -- сопоставленный сотрудник
    text            TEXT NOT NULL
);
CREATE INDEX idx_meeting_segments ON meeting_segments (meeting_id, idx);

CREATE TABLE meeting_summaries (
    meeting_id BIGINT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    summary    TEXT NOT NULL,
    decisions  JSONB NOT NULL DEFAULT '[]'::jsonb,
    risks      JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Черновики задач. ИИ ничего не создаёт молча: строка живёт здесь, пока человек
-- не подтвердит. quote — цитата из стенограммы, по которой предложение можно проверить.
CREATE TABLE meeting_task_drafts (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    meeting_id    BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    title         VARCHAR(255) NOT NULL,
    description   TEXT NULL,
    assignee_id   BIGINT NULL REFERENCES users(id),
    assignee_hint VARCHAR(120) NULL,                   -- имя, как прозвучало на встрече
    project_id    BIGINT NULL REFERENCES projects(id),
    deadline_at   TIMESTAMPTZ NULL,
    quote         TEXT NULL,
    status        VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending | applied | rejected
    task_id       BIGINT NULL REFERENCES tasks(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_meeting_drafts ON meeting_task_drafts (tenant_id, meeting_id, status);
