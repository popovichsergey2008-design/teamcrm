-- Ошибки приложения для консоли разработчика (ТЗ консолей, §4.2–4.3): группа + случаи.
--
-- Группа — по отпечатку (источник, вид, сообщение без чисел, место в коде). Случаи —
-- последние, для поиска по request_id и подсчёта затронутых; хранятся 30 дней.
-- Тексты очищены до записи: ни почты, ни токенов, ни телефонов.

CREATE TABLE app_errors (
  id             BIGSERIAL PRIMARY KEY,
  fingerprint    VARCHAR(40) NOT NULL UNIQUE,
  source         VARCHAR(16) NOT NULL,           -- server | web | mobile
  kind           VARCHAR(120) NOT NULL,
  message        VARCHAR(500) NOT NULL,
  route          VARCHAR(200),
  stack          TEXT,
  first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_version  VARCHAR(64),
  last_version   VARCHAR(64),
  hits           BIGINT NOT NULL DEFAULT 0,
  -- new | fixed | ignored; «исправлено» снова становится new, если ошибка вернулась
  status         VARCHAR(16) NOT NULL DEFAULT 'new',
  fixed_at       TIMESTAMPTZ,
  fixed_version  VARCHAR(64),
  note           VARCHAR(500),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX app_errors_last ON app_errors (last_seen DESC);

CREATE TABLE app_error_events (
  id          BIGSERIAL PRIMARY KEY,
  error_id    BIGINT NOT NULL REFERENCES app_errors(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id  VARCHAR(64),
  version     VARCHAR(64),
  route       VARCHAR(200),
  tenant_id   BIGINT,
  user_id     BIGINT,
  client_id   VARCHAR(64)
);
CREATE INDEX app_error_events_err ON app_error_events (error_id, at DESC);
CREATE INDEX app_error_events_req ON app_error_events (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX app_error_events_at ON app_error_events (at);
