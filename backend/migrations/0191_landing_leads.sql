-- Заявки с рекламной страницы /promo/qevo/ (21.10): квиз «план переезда».
-- Без tenant_id: человек ещё не клиент. Контакт — то, что он сам ввёл (Telegram или телефон).
CREATE TABLE IF NOT EXISTS landing_leads (
  id         BIGSERIAL PRIMARY KEY,
  source     VARCHAR(32)  NOT NULL,
  move_from  VARCHAR(32),
  team_size  VARCHAR(16),
  contact    VARCHAR(120) NOT NULL,
  page       VARCHAR(300),
  ip         VARCHAR(64),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS landing_leads_created_idx ON landing_leads (created_at DESC);
