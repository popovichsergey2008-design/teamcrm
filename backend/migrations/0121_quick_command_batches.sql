-- ТЗ-10, этап 2: пакетное создание задач из быстрой команды.
--
-- Сейчас результат создания живёт только в состоянии окна: перезагрузил страницу —
-- и непонятно, что именно создалось. Пакет делаем сущностью: у него есть номер,
-- состав, состояние каждого элемента и адрес, по которому результат можно открыть
-- снова — завтра, с телефона, по ссылке коллеге.
--
-- Здесь же лечится и повторное нажатие: ключ запроса от клиента уникален в пределах
-- организации, второй такой же запрос возвращает ТОТ ЖЕ пакет, а не создаёт дубли.

CREATE TABLE quick_command_batches (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- text | voice: откуда пришла команда. Нужно и для истории, и для оценки разбора.
    source_type     VARCHAR(16) NOT NULL DEFAULT 'text',
    -- Исходная фраза целиком: по ней видно, что человек просил на самом деле.
    source_text     TEXT NULL,
    -- Запись длинной надиктовки, если команда пришла голосом.
    source_voice_id BIGINT NULL REFERENCES voice_jobs(id) ON DELETE SET NULL,
    -- completed | partial | failed. Состояние «в работе» не храним: пакет из десяти
    -- задач создаётся за секунду, и промежуточное состояние никто не успеет увидеть.
    status          VARCHAR(16) NOT NULL DEFAULT 'completed',
    requested_count SMALLINT NOT NULL DEFAULT 0,
    created_count   SMALLINT NOT NULL DEFAULT 0,
    failed_count    SMALLINT NOT NULL DEFAULT 0,
    -- Ключ запроса от клиента: защита от дублей при обрыве связи.
    client_request_id VARCHAR(64) NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ NULL
);

-- Один и тот же ключ в одной организации — один и тот же пакет.
CREATE UNIQUE INDEX uq_qc_batch_request
    ON quick_command_batches (tenant_id, client_request_id)
    WHERE client_request_id IS NOT NULL;
-- «Мои последние пакеты» — самый частый способ вернуться к результату.
CREATE INDEX idx_qc_batch_user ON quick_command_batches (tenant_id, user_id, id DESC);

-- Элемент пакета: одна задача. Живёт даже если создать её не удалось — иначе
-- человек не узнает, что именно не получилось и что повторять.
CREATE TABLE quick_command_batch_items (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id      BIGINT NOT NULL REFERENCES quick_command_batches(id) ON DELETE CASCADE,
    position      SMALLINT NOT NULL,
    -- Созданная задача; NULL, пока не создалась.
    task_id       BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL,
    -- created | failed
    status        VARCHAR(16) NOT NULL DEFAULT 'created',
    error_message TEXT NULL,
    -- Черновик целиком: по нему повторяют создание, не заставляя человека набирать заново.
    draft         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (batch_id, position)
);

CREATE INDEX idx_qc_item_batch ON quick_command_batch_items (batch_id, position);

-- Откуда взялась задача. Пока единственный источник — быстрая команда; колонка
-- общая намеренно: тем же способом позже пометим задачи из почты и из чата.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_batch_id BIGINT NULL
    REFERENCES quick_command_batches(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_source_batch ON tasks (source_batch_id) WHERE source_batch_id IS NOT NULL;
