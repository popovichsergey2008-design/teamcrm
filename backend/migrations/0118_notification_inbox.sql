/*
  Ящик уведомлений и push (ТЗ-9, волна 4).

  Push ненадёжен по природе: ни Apple, ни Google доставку не обещают. Поэтому
  источник истины — строка в этой таблице: всё, что человеку положено узнать,
  сначала ложится сюда, а уже потом уходит письмом, в Telegram и push'ем. Телефон,
  открывшись, спрашивает «что было после моей последней записи» по номеру строки —
  и получает всё, что push не донёс.

  Одна строка на одно событие одному человеку; ключ — то же письмо из mail_outbox,
  потому что именно оно и есть «событие для человека».
*/
CREATE TABLE notification_inbox (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- монотонный курсор
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mail_id    BIGINT NULL REFERENCES mail_outbox(id) ON DELETE SET NULL,
    event_key  VARCHAR(32) NOT NULL,
    title      VARCHAR(255) NOT NULL,
    body       VARCHAR(500) NOT NULL DEFAULT '',
    path       VARCHAR(500) NULL,                                   -- куда ведёт: /projects/1/task/2
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at    TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX uq_notification_inbox_mail ON notification_inbox (mail_id) WHERE mail_id IS NOT NULL;
CREATE INDEX idx_notification_inbox_user ON notification_inbox (user_id, id DESC);

-- Отметка «push отправлен» на письме: воркер не должен слать дважды после повтора письма.
ALTER TABLE mail_outbox ADD COLUMN push_sent_at TIMESTAMPTZ NULL;

/*
  Приватность push — на организацию (D-07): что показывать на экране блокировки.
  sender_only — «Новое сообщение от Глеба» (по умолчанию), hide — «Новое в ANTHILL»,
  full — заголовок и текст целиком.
*/
ALTER TABLE tenants ADD COLUMN push_privacy VARCHAR(16) NOT NULL DEFAULT 'sender_only';
-- Нижняя граница блокировки биометрией для сотрудников организации (NULL — не задана).
ALTER TABLE tenants ADD COLUMN min_lock_policy VARCHAR(16) NULL;
