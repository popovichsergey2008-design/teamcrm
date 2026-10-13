-- ТЗ-31: обязательный проект и определитель проекта.
--
-- 1. Другие названия проекта (§24): «Alpha», «Клиент Альфа» — чтобы проект узнавался
--    голосом и в переписке не только по официальному имени.
-- 2. Исправления выбора (§25): определитель предложил один проект, человек выбрал другой —
--    запоминаем, чтобы видеть точность и подстраивать пороги.
--
-- tasks.project_id NOT NULL — с самой первой миграции (0001), задач без проекта нет.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS project_resolution_feedback (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  -- откуда задача: chat_draft, voice, nl, meeting, chat_analysis, bot, commitment
  source_type VARCHAR(32) NOT NULL,
  predicted_project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  selected_project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  confidence NUMERIC(4, 2),
  -- AUTO_HIGH_CONFIDENCE | SUGGESTED | NEEDS_CHOICE | NOT_FOUND
  resolution VARCHAR(32),
  reason_codes TEXT[] NOT NULL DEFAULT '{}',
  -- accepted — оставили предложенный; changed — выбрали другой; chosen — предложения не было
  outcome VARCHAR(16) NOT NULL,
  task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_resolution_feedback_tenant ON project_resolution_feedback (tenant_id, created_at DESC);
