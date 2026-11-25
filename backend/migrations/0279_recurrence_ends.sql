-- #5016 (вкладка «Повтор» новой карточки задачи): «каждые N недель/месяцев», срок новой
-- задачи отдельно от времени создания и окончание повтора — после N раз или по дате.
-- Всё необязательное: у прежних повторов поведение не меняется (каждую неделю/месяц,
-- срок = момент создания, без окончания).
ALTER TABLE task_recurrences
    ADD COLUMN every_n    SMALLINT NULL,     -- шаг для weekly/monthly: каждые N недель / месяцев (NULL = 1)
    ADD COLUMN due_days   SMALLINT NULL,     -- срок новой задачи: через N дней после создания (NULL = в день создания)
    ADD COLUMN due_time   VARCHAR(5) NULL,   -- и во сколько, «ЧЧ:ММ» в поясе tz (NULL = время создания)
    ADD COLUMN ends_after INT NULL,          -- закончить после N срабатываний
    ADD COLUMN ends_on    DATE NULL,         -- или после этой даты (включительно, в поясе tz)
    ADD COLUMN runs_count INT NOT NULL DEFAULT 0;
