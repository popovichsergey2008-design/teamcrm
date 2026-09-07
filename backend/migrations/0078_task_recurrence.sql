-- Регулярные задачи: «отчёт каждый понедельник» заводится один раз, а не 52 раза в год.
--
-- Устройство: повтор живёт при ЗАДАЧЕ-ОБРАЗЦЕ (task_recurrences.task_id). По расписанию
-- система создаёт её копию со сдвинутым сроком; копия помечена recurrence_id и потому
-- узнаётся значком на карточке. Образец помечен тем же id — правят повтор именно в нём.
--
-- ГЛАВНОЕ РЕШЕНИЕ (выбор заказчика): по расписанию, НО НЕ ПЛОДИТЬ. Если прежняя задача
-- этого повтора ещё не закрыта, новую не создаём — переносим срок у старой. Иначе на
-- доске к концу месяца висит тридцать одинаковых «Отчётов», и человек перестаёт их
-- видеть вовсе. Пропуск при этом не прячется: сдвинутый срок и запись в истории
-- показывают, что срок наступал.
CREATE TABLE task_recurrences (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    -- задача-образец: с неё снимают поля для копий, в ней же правят расписание
    task_id       BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    -- daily | weekly | monthly | days («каждые N дней»)
    freq          VARCHAR(16) NOT NULL,
    -- дни недели для weekly: 1=понедельник … 7=воскресенье
    weekdays      SMALLINT[] NOT NULL DEFAULT '{}',
    -- число месяца для monthly; 31-е в феврале съезжает на последний день
    monthday      SMALLINT NULL,
    -- шаг для freq='days'
    interval_days SMALLINT NULL,
    -- время срока новой задачи, «ЧЧ:ММ» в поясе tz: «каждый понедельник» без часа
    -- превращается в «в полночь по серверу», а это чужая ночь
    at_time       VARCHAR(5) NOT NULL DEFAULT '10:00',
    tz            VARCHAR(64) NOT NULL DEFAULT 'Europe/Moscow',
    next_run_at   TIMESTAMPTZ NOT NULL,
    last_run_at   TIMESTAMPTZ NULL,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_by    BIGINT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Один повтор на задачу: два расписания на одном образце — это два разных повтора,
-- и заводить их надо двумя задачами, иначе никто не разберёт, какое из них сработало.
CREATE UNIQUE INDEX uq_task_recurrences_task ON task_recurrences (task_id);
-- Планировщик спрашивает ровно одно: «что уже пора».
CREATE INDEX idx_task_recurrences_due ON task_recurrences (next_run_at) WHERE active;

ALTER TABLE tasks ADD COLUMN recurrence_id BIGINT NULL REFERENCES task_recurrences(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_recurrence ON tasks (recurrence_id) WHERE recurrence_id IS NOT NULL;
