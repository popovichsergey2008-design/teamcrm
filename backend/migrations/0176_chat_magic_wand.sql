-- ТЗ-26: «Волшебная палочка» в чатах — сообщение и голосовое → задача.

-- Расшифровка голосового живёт у сообщения: второй раз за неё не платим, и её видно
-- под голосовым кнопкой «Текст» (решение 12.10: ключом компании).
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS transcript TEXT NULL;
-- running | ready | failed | no_stt
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS transcript_status VARCHAR(12) NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS transcribed_at TIMESTAMPTZ NULL;

-- Несколько задач из одного сообщения: номера созданных, по порядку — повтор не плодит дублей.
ALTER TABLE chat_task_drafts ADD COLUMN IF NOT EXISTS created_task_ids BIGINT[] NOT NULL DEFAULT '{}';

-- Фрагмент у задачи из голосового (ТЗ-25 переиспользуется): источник — сообщение чата.
ALTER TABLE task_audio_proofs ALTER COLUMN meeting_id DROP NOT NULL;
ALTER TABLE task_audio_proofs ADD COLUMN IF NOT EXISTS chat_message_id BIGINT NULL REFERENCES chat_messages(id) ON DELETE CASCADE;
ALTER TABLE task_audio_proofs ADD COLUMN IF NOT EXISTS chat_id BIGINT NULL REFERENCES chats(id) ON DELETE SET NULL;
ALTER TABLE task_audio_proofs DROP CONSTRAINT IF EXISTS task_audio_proofs_source_chk;
ALTER TABLE task_audio_proofs ADD CONSTRAINT task_audio_proofs_source_chk CHECK (meeting_id IS NOT NULL OR chat_message_id IS NOT NULL);
