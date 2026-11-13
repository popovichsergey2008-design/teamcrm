-- #4902, п. 4: «Переезд из Slack и Telegram за вечер».
--
-- Архив загружают одним файлом, дальше всё идёт в фоне: разбор, выбор чатов, перенос.
-- Процессов API несколько, поэтому состояние задания живёт в базе, а сам архив — в
-- хранилище файлов: «Перенести» может прилететь в соседний процесс, и он должен
-- найти и задание, и архив.
CREATE TABLE IF NOT EXISTS migration_import_jobs (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_by  BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    source      VARCHAR(16) NOT NULL,                     -- slack | telegram
    file_name   TEXT NOT NULL,
    size_bytes  BIGINT NOT NULL DEFAULT 0,
    -- ключ архива в хранилище; после переноса стираем — чужая переписка не должна
    -- лежать у нас дольше, чем нужна для работы
    object_key  TEXT NULL,
    -- scanning → ready → running → done | failed
    status      VARCHAR(16) NOT NULL DEFAULT 'scanning',
    scan        JSONB NULL,       -- что нашли в архиве: чаты, люди, сообщения — для выбора
    options     JSONB NULL,       -- что выбрал человек: чаты, приглашения, проекты
    progress    JSONB NULL,       -- этап и счётчики — для полоски хода
    report      JSONB NULL,       -- итог: сколько перенесено и что не удалось
    error       TEXT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- «пульс» фоновой работы: если процесс умер посреди переноса, задание не должно
    -- навсегда висеть «в работе» — по давности пульса его признаём прерванным
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at  TIMESTAMPTZ NULL,
    finished_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_migration_import_jobs_tenant ON migration_import_jobs (tenant_id, id DESC);

-- Что уже перенесено: чат Slack/Telegram → наш чат, файл → наш файл.
-- Повторная загрузка того же архива находит здесь свои чаты и файлы и не плодит
-- вторые копии (и не качает файлы заново).
CREATE TABLE IF NOT EXISTS migration_import_refs (
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source_key  VARCHAR(120) NOT NULL,   -- slack:<команда> | tg:<чат>
    kind        VARCHAR(16) NOT NULL,    -- chat | file
    external_id VARCHAR(255) NOT NULL,
    local_id    BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, source_key, kind, external_id)
);

-- Сообщение помнит, откуда оно приехало. Ключ уникален в организации: повторный
-- импорт вставляет только новое (ON CONFLICT DO NOTHING), без единого дубля.
-- import_author — id автора в старой системе: человек, приглашённый при переезде,
-- позже примет приглашение, и повторный импорт подпишет его сообщения его именем.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS import_key TEXT NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS import_author VARCHAR(64) NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_messages_import
    ON chat_messages (tenant_id, import_key) WHERE import_key IS NOT NULL;
