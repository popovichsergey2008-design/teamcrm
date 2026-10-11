-- ТЗ-21, этап 1: единый ящик предложений проактивного секретаря.
--
-- Секретарь сам замечает важное (забытое обещание, перегруз, вопрос без ответа, итоги
-- встречи для клиента) и приносит готовый следующий шаг. Каждое такое «заметил —
-- предлагаю» — строка здесь: с источником, приоритетом, уверенностью и кнопками.
-- Выполнение — через те же сервисы продукта и с той же политикой подтверждения.

CREATE TABLE IF NOT EXISTS assistant_proposals (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- кому предложено
    -- навык: commitment | workload | reply | followup | brief | decision
    skill         VARCHAR(16) NOT NULL,
    -- «больше не предлагать такое» гасит по этому ключу (например, обещания в этом чате)
    kind          VARCHAR(48) NOT NULL DEFAULT '',
    -- источник обязателен (§12): что, где и когда — и ссылка «открыть»
    source_type   VARCHAR(24) NOT NULL,
    source_id     VARCHAR(64) NOT NULL,
    source_at     TIMESTAMPTZ NULL,
    source_label  VARCHAR(200) NULL,
    source_link   VARCHAR(500) NULL,
    -- карточка (§11): что произошло · почему обратил внимание · что рекомендуется · что будет
    title         VARCHAR(200) NOT NULL,
    summary       TEXT NOT NULL DEFAULT '',
    why           TEXT NOT NULL DEFAULT '',
    recommend     TEXT NOT NULL DEFAULT '',
    effect        TEXT NOT NULL DEFAULT '',
    -- 0 — критично, 1 — сегодня, 2 — важно, 3 — к сведению (§81)
    priority      SMALLINT NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
    confidence    NUMERIC(3,2) NOT NULL DEFAULT 0.80,
    -- new | seen | snoozed | executed | dismissed | expired | failed
    status        VARCHAR(12) NOT NULL DEFAULT 'new',
    -- кнопки: [{key, label, risk, primary?}]; выполняет обработчик навыка
    actions       JSONB NOT NULL DEFAULT '[]'::jsonb,
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- отпечаток (§107): навык + источник + смысл + адресат — второй раз то же не предлагаем
    fingerprint   VARCHAR(160) NOT NULL,
    snooze_until  TIMESTAMPTZ NULL,
    expires_at    TIMESTAMPTZ NULL,
    notified_at   TIMESTAMPTZ NULL,
    seen_at       TIMESTAMPTZ NULL,
    resolved_at   TIMESTAMPTZ NULL,
    resolved_action VARCHAR(32) NULL,
    result_text   TEXT NULL,
    error         TEXT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_assistant_proposals_fp ON assistant_proposals (tenant_id, user_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_assistant_proposals_open ON assistant_proposals (tenant_id, user_id, status, priority, created_at DESC)
  WHERE status IN ('new', 'seen', 'snoozed');
CREATE INDEX IF NOT EXISTS idx_assistant_proposals_snooze ON assistant_proposals (snooze_until) WHERE status = 'snoozed';
CREATE INDEX IF NOT EXISTS idx_assistant_proposals_expire ON assistant_proposals (expires_at) WHERE status IN ('new', 'seen', 'snoozed');

-- 👍/👎 с причиной (§109): по ним настраиваются пороги навыков
CREATE TABLE IF NOT EXISTS assistant_proposal_feedback (
    proposal_id BIGINT NOT NULL REFERENCES assistant_proposals(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    useful      BOOLEAN NOT NULL,
    -- wrong_person | wrong_deadline | already_done | not_needed | wrong_context | other
    reason      VARCHAR(24) NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (proposal_id, user_id)
);

-- «Больше не предлагать такое» (§11): навык целиком или конкретный вид (kind)
CREATE TABLE IF NOT EXISTS assistant_proposal_mutes (
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill      VARCHAR(16) NOT NULL,
    kind       VARCHAR(48) NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id, skill, kind)
);

-- Личные настройки проактивности (§90): поверх сводок секретаря (ТЗ-18)
ALTER TABLE secretary_prefs ADD COLUMN IF NOT EXISTS proactive_level VARCHAR(8) NOT NULL DEFAULT 'normal'; -- normal | quiet | off
ALTER TABLE secretary_prefs ADD COLUMN IF NOT EXISTS proactive_daily_limit SMALLINT NOT NULL DEFAULT 12;
ALTER TABLE secretary_prefs ADD COLUMN IF NOT EXISTS smart_reply BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE secretary_prefs ADD COLUMN IF NOT EXISTS morning_audio BOOLEAN NOT NULL DEFAULT TRUE;

-- Навыки на уровне компании (§89): владелец выключает целиком
CREATE TABLE IF NOT EXISTS proactive_settings (
    tenant_id          BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    enabled            BOOLEAN NOT NULL DEFAULT TRUE,
    commitments        BOOLEAN NOT NULL DEFAULT TRUE,
    workload_guard     BOOLEAN NOT NULL DEFAULT TRUE,
    smart_reply        BOOLEAN NOT NULL DEFAULT TRUE,
    client_followup    BOOLEAN NOT NULL DEFAULT TRUE,
    morning_audio      BOOLEAN NOT NULL DEFAULT TRUE,
    second_brain       BOOLEAN NOT NULL DEFAULT TRUE,
    external_send      BOOLEAN NOT NULL DEFAULT TRUE,
    telegram_delivery  BOOLEAN NOT NULL DEFAULT TRUE,
    -- через сколько часов без срока проверять обещание (§21) и когда звать постановщика (§24)
    commitment_check_hours    SMALLINT NOT NULL DEFAULT 24,
    commitment_escalate_hours SMALLINT NOT NULL DEFAULT 48,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
