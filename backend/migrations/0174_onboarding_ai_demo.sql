-- ТЗ-24: «Магия ИИ-созвона за 30 секунд» в онбординге.
--
-- Демо — не встреча: в разделе «Встречи», их показателях и итогах оно не участвует.
-- Своя таблица, свои черновики; задачи после подтверждения — настоящие, на демо-доске.

CREATE TABLE IF NOT EXISTS onboarding_ai_demos (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id        BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- started | processing | review | tasks_created | completed | skipped | failed
    status           VARCHAR(16) NOT NULL DEFAULT 'started',
    -- 'ai' — расшифровка и разбор моделью; 'rules' — речь распознал браузер, разбор правилами
    mode             VARCHAR(8) NOT NULL DEFAULT 'ai',
    -- откуда пришли: welcome | checklist | projects_empty | meetings_empty
    entry_point      VARCHAR(24) NOT NULL DEFAULT 'welcome',
    -- вариант A/B — флагом позже (решение 11.10); пока всем 'ai_call'
    variant          VARCHAR(16) NOT NULL DEFAULT 'ai_call',
    -- как сказали: голосом или текстом (нет микрофона, не хочет говорить)
    input            VARCHAR(8) NULL,
    transcript       TEXT NULL,
    summary          TEXT NULL,
    error            VARCHAR(32) NULL,          -- stt | extract | create
    demo_project_id  BIGINT NULL REFERENCES projects(id) ON DELETE SET NULL,
    draft_count      INT NOT NULL DEFAULT 0,
    created_task_count INT NOT NULL DEFAULT 0,
    audio_seconds    INT NULL,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at         TIMESTAMPTZ NULL,
    reviewed_at      TIMESTAMPTZ NULL,
    tasks_created_at TIMESTAMPTZ NULL,
    completed_at     TIMESTAMPTZ NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_demos_user ON onboarding_ai_demos (tenant_id, user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS onboarding_ai_demo_drafts (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    demo_id      BIGINT NOT NULL REFERENCES onboarding_ai_demos(id) ON DELETE CASCADE,
    idx          SMALLINT NOT NULL,
    title        VARCHAR(255) NOT NULL,
    -- 'task' | 'meeting' — «созвониться с маркетологом» — это встреча, но создаём задачей
    kind         VARCHAR(8) NOT NULL DEFAULT 'task',
    deadline_at  TIMESTAMPTZ NULL,
    -- названный вслух человек, которого нет в команде: «Дизайнер — сотрудник не найден»
    assignee_hint VARCHAR(120) NULL,
    assignee_id  BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    -- pending | applying | created | dismissed | failed
    status       VARCHAR(12) NOT NULL DEFAULT 'pending',
    task_id      BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL,
    error_message VARCHAR(300) NULL,
    UNIQUE (demo_id, idx)
);

-- Демо-проект (§37–38): пока человек не сделал его рабочим, задачи на нём не идут
-- в «Пульс», нагрузку, «Новости» и показатели компании.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
