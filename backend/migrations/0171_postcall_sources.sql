-- ТЗ-22, этапы 3–4: у итогов встречи — источник. Решение, вопрос, черновик задачи
-- ведут к секунде записи и к тому, кто это сказал.

-- решения встречи в журнале: когда и кем произнесено
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS source_sec NUMERIC(10,2) NULL;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS speaker VARCHAR(200) NULL;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS speaker_user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL;

-- открытые вопросы встречи: [{text, sec, speaker}] — отдельно от рисков
ALTER TABLE meeting_summaries ADD COLUMN IF NOT EXISTS questions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- черновик задачи: секунда поручения, кто его произнёс, уверенность в исполнителе,
-- соисполнители и наблюдатели, срочность
ALTER TABLE meeting_task_drafts ADD COLUMN IF NOT EXISTS source_sec NUMERIC(10,2) NULL;
ALTER TABLE meeting_task_drafts ADD COLUMN IF NOT EXISTS source_speaker VARCHAR(200) NULL;
-- 0.9 — исполнитель назван и найден; 0.6 — найден, но модель не уверена; 0.3 — не определён
ALTER TABLE meeting_task_drafts ADD COLUMN IF NOT EXISTS confidence NUMERIC(3,2) NULL;
ALTER TABLE meeting_task_drafts ADD COLUMN IF NOT EXISTS co_assignee_ids BIGINT[] NOT NULL DEFAULT '{}';
ALTER TABLE meeting_task_drafts ADD COLUMN IF NOT EXISTS observer_ids BIGINT[] NOT NULL DEFAULT '{}';
ALTER TABLE meeting_task_drafts ADD COLUMN IF NOT EXISTS priority VARCHAR(16) NULL;
-- правили ли черновик руками — для качества (§52: доля правок названия, исполнителя, срока)
ALTER TABLE meeting_task_drafts ADD COLUMN IF NOT EXISTS edited_fields TEXT[] NOT NULL DEFAULT '{}';
