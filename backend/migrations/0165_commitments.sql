-- ТЗ-21, этап 2: обещания («я пришлю смету сегодня») — чтобы устные и письменные
-- договорённости не терялись. Источники: чаты (включая личные — решение 11.10),
-- обсуждения задач, встречи. Карточка уходит только участникам разговора.

CREATE TABLE IF NOT EXISTS commitments (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id          BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- chat | task | meeting
    source_type        VARCHAR(12) NOT NULL,
    source_id          BIGINT NOT NULL,              -- чат, задача или встреча
    source_message_ids BIGINT[] NOT NULL DEFAULT '{}',
    source_at          TIMESTAMPTZ NOT NULL,
    source_offset_sec  NUMERIC NULL,                 -- секунда записи встречи — «открыть момент»
    quote              TEXT NOT NULL,
    speaker_user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- кто пообещал
    assigner_user_id   BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,      -- кому / кто просил
    project_id         BIGINT NULL REFERENCES projects(id) ON DELETE SET NULL,
    action_text        VARCHAR(200) NOT NULL,
    normalized_action  VARCHAR(120) NOT NULL,
    deadline_at        TIMESTAMPTZ NULL,
    deadline_text      VARCHAR(40) NULL,
    confidence         NUMERIC(3,2) NOT NULL,
    detected_by        VARCHAR(8) NOT NULL DEFAULT 'rules',      -- rules | model
    -- detected → tracked (есть задача) → fulfilled; или needs_followup → … ; dismissed / cancelled
    status             VARCHAR(16) NOT NULL DEFAULT 'detected',
    linked_task_id     BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL,
    check_at           TIMESTAMPTZ NOT NULL,                     -- когда проверить выполнение
    reminded_at        TIMESTAMPTZ NULL,
    remind_count       SMALLINT NOT NULL DEFAULT 0,
    escalated_at       TIMESTAMPTZ NULL,
    fulfilled_at       TIMESTAMPTZ NULL,
    fulfilled_by       VARCHAR(16) NULL,                         -- task | message | user
    cancelled_at       TIMESTAMPTZ NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, source_type, source_id, speaker_user_id, normalized_action)
);
CREATE INDEX IF NOT EXISTS idx_commitments_check ON commitments (check_at) WHERE status IN ('detected', 'tracked', 'needs_followup');
CREATE INDEX IF NOT EXISTS idx_commitments_user ON commitments (tenant_id, speaker_user_id, status);

-- Докуда просмотрены источники: обещания ищем в новом, а не перечитываем всё каждый раз
CREATE TABLE IF NOT EXISTS proactive_cursors (
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source      VARCHAR(24) NOT NULL,           -- chat_messages | task_comments | meetings
    last_id     BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, source)
);
