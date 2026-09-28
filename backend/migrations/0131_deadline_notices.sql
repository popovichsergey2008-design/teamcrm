-- Предупреждение о сроке прямо в обсуждении задачи (просьба заказчика, как в Битриксе).
--
-- Зачем. О приближении срока сейчас узнаёт только тот, кто сам зашёл в задачу или
-- прочитал сводку секретаря. Строка в самом обсуждении видна ВСЕМ участникам и там,
-- где работа обсуждается: «задача почти просрочена, крайний срок 21 сентября, 15:00».
--
-- Пишет её не человек, поэтому у сообщения появляется отдельный вид — системное.
-- Раньше автор был обязателен: системному сообщению пришлось бы приписывать чужое имя.
ALTER TABLE task_comments
    ALTER COLUMN author_id DROP NOT NULL;

ALTER TABLE task_comments
    ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

-- Что уже сказано про этот срок.
--
-- Ключ — задача, вид предупреждения и САМ СРОК: перенесли срок — значит про новый
-- предупредим заново (в Битриксе так же, и это правильно: новый срок — новое обещание).
-- Без этой таблицы проход планировщика каждые пять минут завалил бы обсуждение
-- одинаковыми строками.
CREATE TABLE IF NOT EXISTS task_deadline_notices (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    task_id     BIGINT      NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    -- soon — срок близко; overdue — срок прошёл.
    kind        TEXT        NOT NULL,
    deadline_at TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (task_id, kind, deadline_at)
);

CREATE INDEX IF NOT EXISTS task_deadline_notices_task_idx ON task_deadline_notices (task_id);
