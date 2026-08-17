-- Почтовые уведомления по задачам: создание, комментарии, смена статуса.
--
-- Отправляем через внешний транзакционный сервис по HTTPS: свой SMTP с этого
-- сервера невозможен (хостер держит порты 25/587/465 закрытыми), да и письма
-- без SPF/DKIM с типовым PTR всё равно уходили бы в спам.

-- Очередь писем. Устроена как integration_outbox: доменные сервисы только
-- кладут задание, отправляет отдельный обработчик с повторами. Падение почтового
-- сервиса или перезапуск приложения не теряет уведомления.
CREATE TABLE mail_outbox (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
    user_id         BIGINT NULL REFERENCES users(id),   -- получатель в системе (для отписки)
    to_email        VARCHAR(320) NOT NULL,
    subject         VARCHAR(255) NOT NULL,
    body_text       TEXT NOT NULL,
    body_html       TEXT NULL,
    event_key       VARCHAR(32) NOT NULL,               -- task.created | task.commented | task.status
    -- Ключ повтора: одно событие одному человеку = одно письмо, даже если
    -- доменный сервис дёрнут дважды (повтор вебхука, двойной клик).
    dedup_key       VARCHAR(160) NOT NULL,
    status          VARCHAR(12) NOT NULL DEFAULT 'pending',  -- pending|sending|done|error
    attempts        INT NOT NULL DEFAULT 0,
    last_error      VARCHAR(500) NULL,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at         TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX uq_mail_outbox_dedup ON mail_outbox (dedup_key);
CREATE INDEX idx_mail_outbox_queue ON mail_outbox (status, next_attempt_at, id);

-- Настройки уведомлений. Строки нет — действуют значения по умолчанию:
-- личное касание присылаем, остальное молчит. Так новый сотрудник получает
-- полезное с первого дня и при этом не тонет в письмах.
CREATE TABLE notification_prefs (
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    event_key   VARCHAR(32) NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, event_key)
);

-- Отписка одним кликом из письма. Токен личный и не выводится в интерфейсе:
-- ссылка в письме должна работать без входа в систему.
ALTER TABLE users ADD COLUMN unsubscribe_token VARCHAR(64) NULL;
CREATE UNIQUE INDEX uq_users_unsub ON users (unsubscribe_token) WHERE unsubscribe_token IS NOT NULL;
