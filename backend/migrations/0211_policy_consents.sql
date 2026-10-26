-- #4675: журнал согласий с политиками.
--
-- Два документа: Политика конфиденциальности (галочка при регистрации — своей
-- организации, по приглашению, по ссылке, через Google) и Политика удалённой
-- поддержки (галочка перед каждой сессией удалённой помощи). Политика удалённой
-- поддержки прямо обещает: «Время, IP-адрес и версия текста сохраняются в журнал».
--
-- Строки не удаляются вместе с человеком или организацией: это доказательство
-- согласия, поэтому ссылки обнуляются (SET NULL), а сама запись остаётся.
-- context — откуда пришло согласие: {"flow":"register"} или
-- {"conversationId":"…","via":"button|screen|access"} для удалённой помощи.

CREATE TABLE IF NOT EXISTS policy_consents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NULL REFERENCES tenants(id) ON DELETE SET NULL,
  user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  policy VARCHAR(20) NOT NULL CHECK (policy IN ('privacy', 'remote_support')),
  version VARCHAR(20) NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(250) NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_policy_consents_user ON policy_consents (tenant_id, user_id, policy, accepted_at DESC);
