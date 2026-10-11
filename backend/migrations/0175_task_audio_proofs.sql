-- ТЗ-25: аудио-доказательство задачи — фрагмент созвона, где прозвучало поручение.
--
-- Решение заказчика 11.10: фрагмент вырезается отдельным коротким файлом с правами
-- ЗАДАЧИ (files.owner_kind = 'task_audio_proof'), а указатель на встречу и секунды
-- хранится рядом — для «Открыть созвон с 31:14» и пересборки после правки диапазона.
CREATE TABLE IF NOT EXISTS task_audio_proofs (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id        BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    task_id          BIGINT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    meeting_id       BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    draft_id         BIGINT NULL REFERENCES meeting_task_drafts(id) ON DELETE SET NULL,
    -- запись встречи, из которой вырезан фрагмент, и сам фрагмент
    source_file_id   BIGINT NULL REFERENCES files(id) ON DELETE SET NULL,
    clip_file_id     BIGINT NULL REFERENCES files(id) ON DELETE SET NULL,
    anchor_ms        INT NOT NULL,
    start_ms         INT NOT NULL,
    end_ms           INT NOT NULL,
    speaker          VARCHAR(200) NULL,
    speaker_user_id  BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    quote_text       TEXT NULL,
    -- meeting_acl — все, кто видит задачу, видят и встречу; task_scoped — фрагмент
    -- разрешили показать тем, кто встречу не видит (с подтверждением, §28)
    visibility_policy VARCHAR(16) NOT NULL DEFAULT 'meeting_acl',
    -- pending | ready | failed | revoked
    status           VARCHAR(12) NOT NULL DEFAULT 'pending',
    error            VARCHAR(300) NULL,
    play_count       INT NOT NULL DEFAULT 0,
    last_played_at   TIMESTAMPTZ NULL,
    created_by       BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audio_proofs_meeting ON task_audio_proofs (tenant_id, meeting_id);

-- «Подтвердить всё» нажали (§53: доля разборов одним нажатием)
ALTER TABLE meeting_postcall_reviews ADD COLUMN IF NOT EXISTS confirm_all_at TIMESTAMPTZ NULL;
