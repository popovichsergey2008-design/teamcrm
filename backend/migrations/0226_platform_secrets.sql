-- Реестр общих ключей платформы (ТЗ консолей, §5.6; 02.11).
--
-- Общие ключи (ИИ, поиск, демо) раньше жили только в .env сервера: заменить ключ
-- значило зайти на сервер и перезапустить API. Теперь владелец платформы заменяет
-- их в консоли, не видя значения:
--   добавить новую версию → проверить → активировать (прежняя — «выведена») → отозвать.
-- Значение хранится зашифрованным ключом сервера (INTEGRATION_ENC_KEY лежит вне базы)
-- и наружу не отдаётся никогда: ни в консоль, ни в журнал, ни в ошибки — только
-- последние 4 символа. У отозванной версии значение стирается.
-- Нет активной версии — действует значение из .env, как раньше.
-- Ключи компаний-клиентов (ai_settings и др.) — отдельно, здесь их нет.

CREATE TABLE platform_secrets (
  id             BIGSERIAL PRIMARY KEY,
  -- имя переменной, которую ключ заменяет: OPENAI_API_KEY, KIMI_API_KEY, …
  name           VARCHAR(64) NOT NULL,
  version        INT NOT NULL,
  value_enc      TEXT,
  last4          VARCHAR(8) NOT NULL,
  -- pending — добавлен, не используется; active — используется; retired — выведен (можно вернуть); revoked — отозван, значение стёрто
  status         VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'retired', 'revoked')),
  environment    VARCHAR(16) NOT NULL DEFAULT 'production',
  note           VARCHAR(300),
  expires_at     DATE,
  check_ok       BOOLEAN,
  check_message  VARCHAR(300),
  checked_at     TIMESTAMPTZ,
  created_by     BIGINT REFERENCES pc_accounts(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at   TIMESTAMPTZ,
  activated_by   BIGINT REFERENCES pc_accounts(id),
  retired_at     TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  revoked_by     BIGINT REFERENCES pc_accounts(id),
  revoke_reason  VARCHAR(300),
  UNIQUE (name, version)
);
-- активна не больше одной версии ключа
CREATE UNIQUE INDEX platform_secrets_active ON platform_secrets (name) WHERE status = 'active';
