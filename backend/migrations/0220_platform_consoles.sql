-- Консоли платформы (ТЗ QEVO_PLATFORM_CONSOLES_SPEC, 31.10): owner / developer / support.qevo.one.
--
-- Свои учётные записи, НЕ связанные с accounts/users CRM. Решение заказчика: разработчики
-- и владелец регистрируются в консоли отдельно — в прежней схеме персонал был
-- сотрудниками компании вендора, и чаты, уведомления, звонки CRM текли к ним в консоль.
-- Здесь нет ни tenant_id, ни user_id: консоль не участник переписки и не получатель
-- уведомлений, данные берёт только сводками через свои серверные запросы.

CREATE TABLE pc_accounts (
  id               BIGSERIAL PRIMARY KEY,
  email            VARCHAR(255) NOT NULL,
  full_name        VARCHAR(255) NOT NULL,
  password_hash    VARCHAR(255) NOT NULL,
  -- pending — ждёт одобрения владельца; active; blocked
  status           VARCHAR(16)  NOT NULL DEFAULT 'pending',
  -- owner | developer | support — какие консоли открыты; доступ в одну не даёт другие
  roles            TEXT[]       NOT NULL DEFAULT '{}',
  requested_role   VARCHAR(16),
  totp_secret_enc  TEXT,
  totp_enabled_at  TIMESTAMPTZ,
  totp_last_step   BIGINT,
  approved_by      BIGINT REFERENCES pc_accounts(id),
  approved_at      TIMESTAMPTZ,
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pc_accounts_email_uq ON pc_accounts (lower(email));

-- Сессия — на одну консоль (app): вход в owner не открывает developer.
CREATE TABLE pc_sessions (
  id            BIGSERIAL PRIMARY KEY,
  account_id    BIGINT NOT NULL REFERENCES pc_accounts(id) ON DELETE CASCADE,
  app           VARCHAR(16) NOT NULL,
  refresh_hash  VARCHAR(64) NOT NULL UNIQUE,
  ip            VARCHAR(64),
  user_agent    VARCHAR(255),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pc_sessions_account ON pc_sessions (account_id) WHERE revoked_at IS NULL;

-- Журнал консолей: кто, что, над чем, откуда. Значения секретов сюда не пишутся.
CREATE TABLE pc_audit (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT REFERENCES pc_accounts(id),
  app         VARCHAR(16),
  action      VARCHAR(64) NOT NULL,
  target      VARCHAR(128),
  meta        JSONB NOT NULL DEFAULT '{}',
  ip          VARCHAR(64),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pc_audit_at ON pc_audit (created_at DESC);

-- Тестовые компании не попадают в коммерческую статистику (ТЗ §5.2). До запуска все
-- существующие компании — наши проверки и автотесты; живая регистрация из бота (116)
-- и всё новое — настоящие. Владелец переключает отметку в консоли.
ALTER TABLE tenants ADD COLUMN is_test BOOLEAN NOT NULL DEFAULT false;
UPDATE tenants SET is_test = true WHERE id <= 115;
