-- Напоминания о событиях календаря и вложения в письмах.

-- За сколько минут до начала напомнить. Несколько напоминаний на событие — норма:
-- «за день, чтобы подготовиться» и «за десять минут, чтобы дойти» — разные вещи.
CREATE TABLE calendar_reminders (
    event_id       BIGINT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    minutes_before INT NOT NULL,
    PRIMARY KEY (event_id, minutes_before),
    CHECK (minutes_before BETWEEN 0 AND 20160)   -- до двух недель
);

-- Что уже отправлено. Без этой таблицы планировщик, просыпаясь раз в минуту, слал бы
-- одно и то же напоминание столько раз, сколько минут длится его окно.
CREATE TABLE calendar_reminder_log (
    event_id       BIGINT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    user_id        BIGINT NOT NULL REFERENCES users(id),
    minutes_before INT NOT NULL,
    -- Время начала события на момент отправки: событие перенесли — напомним заново,
    -- иначе человек получит напоминание о встрече, которой в это время уже нет.
    starts_at      TIMESTAMPTZ NOT NULL,
    sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, user_id, minutes_before, starts_at)
);

-- Вложения письма: приглашение возит с собой .ics, чтобы встреча легла в тот календарь,
-- которым человек уже пользуется. Хранится как [{name, contentBase64}] — ровно то, что
-- принимает почтовый сервис.
ALTER TABLE mail_outbox ADD COLUMN attachments JSONB NULL;
