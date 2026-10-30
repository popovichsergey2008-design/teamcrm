-- #4692: видео до 400 МБ и сжатие на сервере (FFmpeg, 720p, CRF 26 — рецепт заказчика).
--
-- Видео сразу после загрузки доступно как есть, в фоне сжимается, и сжатая копия
-- подменяет оригинал у той же строки files — ссылки из чатов и задач не меняются.
-- Оригинал живёт ещё 2 дня (решение заказчика 30.10: «чтоб не лежало»), потом удаляется.
-- Общий потолок под видео — VIDEO_STORAGE_GB (по умолчанию 100 ГБ): считается по files.

ALTER TABLE files
    ADD COLUMN original_key       TEXT NULL,          -- ключ несжатого оригинала в хранилище
    ADD COLUMN original_bytes     BIGINT NULL,
    ADD COLUMN original_delete_at TIMESTAMPTZ NULL,   -- когда стереть оригинал
    ADD COLUMN compressed_at      TIMESTAMPTZ NULL;

CREATE INDEX idx_files_original_delete ON files (original_delete_at) WHERE original_delete_at IS NOT NULL;
CREATE INDEX idx_files_video ON files (content_type) WHERE content_type LIKE 'video/%';

-- Очередь сжатия: одна строка на файл. Забирает свободный процесс API (два при выкладке
-- blue/green не возьмут одну и ту же — FOR UPDATE SKIP LOCKED).
CREATE TABLE video_jobs (
    file_id     BIGINT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    status      VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'done', 'skipped', 'failed')),
    attempts    INT NOT NULL DEFAULT 0,
    last_error  TEXT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at  TIMESTAMPTZ NULL,
    finished_at TIMESTAMPTZ NULL
);
CREATE INDEX idx_video_jobs_pending ON video_jobs (created_at) WHERE status IN ('pending', 'running');
