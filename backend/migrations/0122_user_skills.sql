-- ТЗ-10, этап 3: чем занимается сотрудник и можно ли ставить ему задачи автоматически.
--
-- Отделы в системе уже есть (groups.kind='department'), но «бэкенд он или фронтенд»
-- нигде не записано, а по должности это угадывать нельзя: должности называют как
-- угодно («Разработчик», «Специалист»), и ИИ, глядя на такое, начнёт фантазировать.
-- Решение заказчика (23.09): специализации — отдельным списком у человека, потому
-- что один и тот же сотрудник часто и бэкенд, и фронтенд.
--
-- Автоназначение разрешено ВСЕМ по умолчанию (тоже решение заказчика): иначе функция
-- не работает до тех пор, пока владелец не пройдёт по всей команде руками. Кого
-- исключать — руководителя, стажёра, человека в отпуске — решают точечно.

-- Направления сотрудника. Список, а не одно поле: «и бэкенд, и фронтенд» — обычное дело.
CREATE TABLE user_skills (
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- backend | frontend | fullstack | content | design | qa | analytics | other
    skill      VARCHAR(24) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, skill)
);
CREATE INDEX idx_user_skills_tenant ON user_skills (tenant_id, skill);

ALTER TABLE users
    -- «ИИ может предлагать меня исполнителем». По умолчанию да — см. выше.
    ADD COLUMN IF NOT EXISTS can_receive_auto_tasks BOOLEAN NOT NULL DEFAULT true,
    -- Вес при подборе: 1.0 обычный, 0.5 «в последнюю очередь», 2.0 «в первую».
    -- Дробь намеренно: иначе единственный способ поднять человека в очереди —
    -- выключить остальных.
    ADD COLUMN IF NOT EXISTS auto_assignment_weight NUMERIC(3,1) NOT NULL DEFAULT 1.0;
