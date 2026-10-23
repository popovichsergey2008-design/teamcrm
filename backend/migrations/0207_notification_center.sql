/*
  Центр уведомлений (#4655).

  Ящик уведомлений (0118) уже был правдой о событиях для телефона, но наполнялся
  в основном письмами: о задаче человек узнавал, только если ему положено письмо,
  а наблюдатель, соисполнитель и упомянутый в обсуждении не узнавали вовсе. Всплывашка
  «блымала» и пропадала — задачу потом искали руками.

  Теперь у каждой записи о задаче есть автор, задача и подробности (исполнитель, срок,
  кусок комментария) — по ним центр рисует строку как в Битриксе: «Ольга назначила вас
  исполнителем [#12] Обновить прайс». Название задачи берётся при показе из самой задачи:
  её переименовали — история показывает новое имя, удалили — запись не видна.

  `dedup_key` — тот же ключ, что у письма об этом событии: письмо, дошедшее до воркера,
  не заводит вторую строку, а пристёгивается к уже записанной центром.
*/
ALTER TABLE notification_inbox
    ADD COLUMN actor_id  BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN task_id   BIGINT NULL,                       -- без FK: удалённая задача просто прячет запись
    ADD COLUMN details   JSONB NULL,
    ADD COLUMN dedup_key VARCHAR(160) NULL,
    /*
      Вид записи для фильтра центра: задачи, комментарии, упоминания, чаты, встречи,
      прочее. Считается из ключа события — так в фильтр сразу попадают и старые записи.
    */
    ADD COLUMN category  VARCHAR(16) GENERATED ALWAYS AS (
        CASE
            WHEN event_key IN ('task.mention', 'chat.mention', 'feed.mention') THEN 'mention'
            WHEN event_key = 'task.commented' THEN 'comment'
            WHEN event_key LIKE 'task.%' THEN 'task'
            WHEN event_key LIKE 'chat.%' THEN 'chat'
            WHEN event_key LIKE 'meet%' OR event_key LIKE 'calendar.%' THEN 'meet'
            ELSE 'other'
        END
    ) STORED;

CREATE UNIQUE INDEX uq_notification_inbox_dedup ON notification_inbox (user_id, dedup_key) WHERE dedup_key IS NOT NULL;
-- счётчик на значке спрашивают на каждое событие — только непрочитанное и без перебора истории
CREATE INDEX idx_notification_inbox_unread ON notification_inbox (user_id, id) WHERE read_at IS NULL;
CREATE INDEX idx_notification_inbox_task ON notification_inbox (tenant_id, task_id) WHERE task_id IS NOT NULL;

-- Старым записям о задачах — номер задачи из пути (/projects/1/task/2): центр проверит по нему доступ.
UPDATE notification_inbox
   SET task_id = substring(path from '/task/([0-9]{1,18})')::bigint
 WHERE task_id IS NULL AND path ~ '/task/[0-9]+';
