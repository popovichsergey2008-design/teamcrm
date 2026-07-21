-- Голосовые заметки во «Входящие»: надиктовал → Whisper → черновик задачи на ревью.
-- У голосовой заметки нет канала-вебхука, поэтому source_id становится необязательным.
ALTER TABLE inbox_items ALTER COLUMN source_id DROP NOT NULL;
