-- Удаление задачи, по которой уже учтено время.
--
-- Раньше такие задачи не удалялись вовсе: часы попали в себестоимость проекта,
-- и стереть их значило задним числом изменить P&L — деньги за эту работу людям
-- уже начислены, а клиенту, возможно, выставлены. Запрет был честным, но в него
-- попадали и явные ошибки: случайный запуск таймера на две секунды запирал задачу
-- навсегда, а убрать лишнюю запись из интерфейса было нельзя.
--
-- Теперь владелец может удалить такую задачу, но ЧАСЫ И ДЕНЬГИ НЕ ИСЧЕЗАЮТ:
-- они переезжают сюда и продолжают участвовать в расчётах проекта. Задача уходит
-- с доски, себестоимость остаётся на месте.

-- Стоимость удалённой задачи. Одна строка на задачу — ровно то, что раньше
-- лежало в её поле себестоимости и суммировалось в P&L проекта.
CREATE TABLE deleted_task_costs (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    project_id BIGINT NOT NULL REFERENCES projects(id),
    -- Без внешнего ключа: задачи уже нет, а строка про неё должна жить дальше.
    task_id    BIGINT NOT NULL,
    task_title VARCHAR(255) NOT NULL,
    cost       NUMERIC(14,2) NOT NULL DEFAULT 0,
    deleted_by BIGINT NULL REFERENCES users(id),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_deleted_task_costs_project ON deleted_task_costs (tenant_id, project_id);

-- Записи таймера удалённой задачи — построчно, как были.
-- Нужны не для красоты: по ним считаются часы проекта в отчёте «стоимость работы»
-- и таймлайн загрузки людей. Свернуть их в одно число значило бы потерять, кто и когда работал.
CREATE TABLE deleted_time_logs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
    project_id      BIGINT NOT NULL REFERENCES projects(id),
    task_id         BIGINT NOT NULL,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    timestamp_start TIMESTAMPTZ NOT NULL,
    timestamp_end   TIMESTAMPTZ NULL,
    deleted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_deleted_time_logs_project ON deleted_time_logs (tenant_id, project_id);
CREATE INDEX idx_deleted_time_logs_user ON deleted_time_logs (tenant_id, user_id, timestamp_start);
