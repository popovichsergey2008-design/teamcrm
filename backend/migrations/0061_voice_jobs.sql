-- Длинная голосовая постановка задач.
--
-- Пятиминутная надиктовка падала с ошибкой: тело запроса упиралось в умолчание nginx
-- (1 МБ), а расшифровка с разбором не укладывалась в 60 секунд прокси. Человек диктовал
-- пять минут и получал красный экран — вместе с записью, которой больше нет.
--
-- Лимиты подняты в nginx, но одного этого мало: обработка длинного аудио идёт минутами,
-- и держать всё это время открытый запрос — значит снова зависеть от любого таймаута
-- по пути. Поэтому запись принимается отдельно от разбора: файл сохраняется, работа
-- идёт в фоне, интерфейс показывает, на каком она шаге.
CREATE TABLE voice_jobs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    user_id       BIGINT NOT NULL REFERENCES users(id),
    -- Исходное аудио в хранилище. Главное свойство: файл переживает ЛЮБУЮ ошибку
    -- разбора — переспрашивать человека, который только что говорил десять минут,
    -- нельзя.
    file_id       BIGINT NULL REFERENCES files(id),
    -- queued | transcribing | parsing | ready | error
    status        VARCHAR(16) NOT NULL DEFAULT 'queued',
    transcript    TEXT NULL,
    -- Разобранные черновики задач: в одной записи их может быть несколько.
    drafts        JSONB NOT NULL DEFAULT '[]'::jsonb,
    error         VARCHAR(500) NULL,
    duration_sec  INT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Свои записи человек открывает списком «что я надиктовал» и повторяет обработку.
CREATE INDEX idx_voice_jobs_user ON voice_jobs (tenant_id, user_id, created_at DESC);
