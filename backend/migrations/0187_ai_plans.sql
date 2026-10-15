-- ТЗ-33: тарифы ИИ — «Базовый» (ИИ только внутри CRM) и «Расширенный» (+ интернет).
--
-- 1. Тариф организации. Разница тарифов — серверная политика: веб-инструменты
--    модели выдаются только при AI_EXTENDED, а не прячутся кнопкой.
-- 2. Журнал расхода — существующая ai_usage, дополненная тем, чего в ней не было:
--    кто, каким запросом, категория (CRM-ИИ / интернет / речь), веб-запросы и
--    страницы, списанные кредиты. Сырые события — источник правды для счёта.
-- 3. Резерв веб-кредитов: два параллельных запроса не должны вместе перейти лимит.
--
-- Оплаты нет (решение 15.10): тариф, статус и кредиты меняет вендор из консоли.

CREATE TABLE IF NOT EXISTS tenant_ai_plans (
  tenant_id BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code VARCHAR(16) NOT NULL CHECK (plan_code IN ('AI_BASIC', 'AI_EXTENDED')),
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trial_ends_at TIMESTAMPTZ,
  -- веб-кредиты на период: 1 кредит = 1 поиск или 1 прочитанная страница
  included_web_credits INT NOT NULL DEFAULT 0,
  -- CRM-ИИ пока без потолка; поле — под будущие тарифы
  included_ai_credits INT NOT NULL DEFAULT 0,
  -- «Остановить интернет-ИИ при исчерпании лимита» — по ТЗ включено по умолчанию
  hard_limit_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- последний порог (50/80/100), о котором уже сказали владельцу в этом периоде
  notified_pct INT NOT NULL DEFAULT 0,
  notified_period VARCHAR(16),
  -- владелец попросил «Расширенный» — видно вендору в консоли
  upgrade_requested_at TIMESTAMPTZ,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS user_id BIGINT;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS request_id VARCHAR(64);
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS provider VARCHAR(32);
-- AI_INTERNAL | AI_WEB | STT | TTS | EMBEDDINGS
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS usage_category VARCHAR(16) NOT NULL DEFAULT 'AI_INTERNAL';
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS web_requests INT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS pages_fetched INT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS bytes_processed BIGINT NOT NULL DEFAULT 0;
-- сколько веб-кредитов списано этим событием (свой ключ клиента — 0)
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS web_credits INT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS plan_code VARCHAR(16);
-- повтор того же запроса (ретрай) не списывает дважды
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ai_usage_request ON ai_usage (tenant_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_usage_web ON ai_usage (tenant_id, created_at) WHERE usage_category = 'AI_WEB';

-- старые записи: речь и голос — по модели
UPDATE ai_usage SET usage_category = 'STT' WHERE model IN ('whisper-1', 'mock-stt') AND usage_category = 'AI_INTERNAL';
UPDATE ai_usage SET usage_category = 'TTS' WHERE model LIKE 'tts%' AND usage_category = 'AI_INTERNAL';
UPDATE ai_usage SET usage_category = 'EMBEDDINGS' WHERE feature = 'embedding' AND usage_category = 'AI_INTERNAL';

CREATE TABLE IF NOT EXISTS ai_web_reservations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id BIGINT,
  credits INT NOT NULL,
  -- брошенный резерв (процесс упал посреди запроса) сам истекает
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '2 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_web_reservations_tenant ON ai_web_reservations (tenant_id, expires_at);

-- Существующие организации — «Базовый» (решение 15.10). Площадка вендора (у неё
-- веб-поиск уже включён) — «Расширенный» с месячным запасом.
INSERT INTO tenant_ai_plans (tenant_id, plan_code, status, included_web_credits)
SELECT t.id,
       CASE WHEN t.is_platform THEN 'AI_EXTENDED' ELSE 'AI_BASIC' END,
       'ACTIVE',
       CASE WHEN t.is_platform THEN 1000 ELSE 0 END
  FROM tenants t
ON CONFLICT (tenant_id) DO NOTHING;

-- Флажок бота «может ходить в интернет» теперь включён по умолчанию: решает тариф,
-- а владелец Расширенного может выключить интернет боту отдельно.
ALTER TABLE ai_agent_settings ALTER COLUMN web_search SET DEFAULT TRUE;
UPDATE ai_agent_settings SET web_search = TRUE WHERE web_search = FALSE;
