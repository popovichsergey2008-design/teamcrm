-- #4863 ТЗ сайта: заявки сайта в его формате, реферальный код в аккаунте, «Отправить коллеге».

-- заявки сайта длиннее прежних полей (свободное «откуда», «команда», почта в контакте)
ALTER TABLE landing_leads ALTER COLUMN source TYPE VARCHAR(40);
ALTER TABLE landing_leads ALTER COLUMN move_from TYPE VARCHAR(120);
ALTER TABLE landing_leads ALTER COLUMN team_size TYPE VARCHAR(60);
ALTER TABLE landing_leads ALTER COLUMN contact TYPE VARCHAR(180);

-- ссылка «Пригласить команду» с сайта: qevo.one/?ref=<код> → код уходит в регистрацию
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS referral_code VARCHAR(16) NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_referral_code ON tenants (referral_code) WHERE referral_code IS NOT NULL;
ALTER TABLE signup_attribution ADD COLUMN IF NOT EXISTS signup_utm_term VARCHAR(200) NULL;
ALTER TABLE signup_attribution ADD COLUMN IF NOT EXISTS referral_code VARCHAR(40) NULL;
ALTER TABLE signup_attribution ADD COLUMN IF NOT EXISTS referrer_tenant_id BIGINT NULL REFERENCES tenants(id) ON DELETE SET NULL;

-- «Отправить коллеге»: результат демо по ссылке qevo.one/demo/<код>, 30 дней, без личных данных
CREATE TABLE IF NOT EXISTS demo_shares (
    code        VARCHAR(12) PRIMARY KEY,
    message     TEXT NOT NULL,
    task        JSONB NOT NULL,
    og_png      BYTEA NULL,
    views       INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days'
);
CREATE INDEX IF NOT EXISTS idx_demo_shares_expires ON demo_shares (expires_at);
