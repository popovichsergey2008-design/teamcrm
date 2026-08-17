-- Диагностический журнал созвонов и чатов.
--
-- Прошлая ошибка приёма звука была невидимой ровно потому, что сервер молча
-- отбрасывал преждевременный запрос: в логах пусто, у людей «не слышно».
-- Здесь пишутся обе стороны — и сигналинг сервера, и события браузера, —
-- сведённые в одну ленту по времени. Без этого разбирать созвон, который
-- случился час назад у двух других людей, можно только гаданием.
--
-- Содержимого сообщений тут нет и не будет: только идентификаторы, типы
-- событий и технические детали. Журнал для поиска поломок, а не для чтения
-- чужой переписки.

CREATE TABLE diag_events (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  BIGINT NULL REFERENCES tenants(id),
    scope      VARCHAR(16) NOT NULL,      -- meet | chat
    ref_id     VARCHAR(64) NULL,          -- id созвона или чата
    user_id    BIGINT NULL,               -- без внешнего ключа: события переживают удаление людей
    side       VARCHAR(8) NOT NULL,       -- server | client
    event      VARCHAR(48) NOT NULL,
    data       JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Основной способ чтения: вся лента одного созвона по порядку.
CREATE INDEX idx_diag_ref ON diag_events (scope, ref_id, id);
-- Для чистки старого.
CREATE INDEX idx_diag_time ON diag_events (created_at);
