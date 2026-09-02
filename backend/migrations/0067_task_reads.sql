-- Что нового в задаче лично для меня.
--
-- События по задачам мы пишем давно (task_activity: перенос, комментарий, правка полей,
-- файл, чек-лист, согласование), но узнать «что изменилось, пока меня не было» внутри
-- CRM было негде: об этом сообщали только письмо, дубль в Telegram и сводка секретаря.
-- На карточке доски стоят счётчики «💬 3» и «📎 2» — но это ВСЕГО, а не НОВОГО: задача
-- с тремя вчерашними комментариями выглядела так же, как задача с тремя сегодняшними.
--
-- Не хватало одного понятия — отметки «я это видел». Дальше непрочитанное считается так
-- же, как в чатах: события позже отметки, чужие (свои действия себе не новость).
CREATE TABLE task_reads (
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    task_id      BIGINT NOT NULL REFERENCES tasks(id),
    user_id      BIGINT NOT NULL REFERENCES users(id),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, user_id)
);
CREATE INDEX idx_task_reads_user ON task_reads (tenant_id, user_id);

-- Всё, что случилось ДО появления этой возможности, считаем прочитанным.
--
-- Иначе в первый же день после обновления у каждого краснеет вся доска: у всех задач
-- отметки нет, а значит «новыми» становятся все события за всю историю проекта. Красное
-- везде — это то же самое, что красного нет нигде, и человек перестаёт на него смотреть.
INSERT INTO task_reads (tenant_id, task_id, user_id, last_seen_at)
SELECT t.tenant_id, t.id, m.user_id, now()
  FROM tasks t
  JOIN LATERAL (
        SELECT t.assignee_id AS user_id WHERE t.assignee_id IS NOT NULL
  UNION SELECT t.created_by            WHERE t.created_by IS NOT NULL
  UNION SELECT p.user_id FROM task_participants p WHERE p.task_id = t.id
  ) m ON TRUE
ON CONFLICT DO NOTHING;
