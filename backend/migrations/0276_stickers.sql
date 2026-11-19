-- ТЗ «Стикеры-напоминалки» (#4997, 19.11.2026): цветной листок с одной мыслью на доске по датам.
-- Только текст, дата и время (необязательны) и цвет — без проектов, исполнителей и статусов.
-- Стикеры личные: видит только автор.
CREATE TABLE IF NOT EXISTS stickers (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- заголовок на листке; длинная надиктовка — целиком в body («развернуть»)
  text         TEXT NOT NULL,
  body         TEXT NULL,
  due_date     DATE NULL,          -- нет даты — колонка «Идеи без даты»
  due_time     TIME NULL,          -- есть время — напоминание в срок (пункт 6)
  color        VARCHAR(16) NOT NULL DEFAULT 'yellow',
  position     DOUBLE PRECISION NOT NULL DEFAULT 0,
  source       VARCHAR(16) NOT NULL DEFAULT 'manual', -- manual | voice | bot | chat | telegram
  source_ref   JSONB NULL,          -- откуда: сообщение чата (chatId, messageId)
  done_at      TIMESTAMPTZ NULL,    -- «Сделано» хранится 30 дней
  deleted_at   TIMESTAMPTZ NULL,    -- корзина 30 дней
  reminded_at  TIMESTAMPTZ NULL,    -- напоминание по времени ушло (один раз)
  snooze_until TIMESTAMPTZ NULL,    -- «Через 15 мин» / «Через час» из напоминания
  task_id      BIGINT NULL,         -- «Сделать задачей»
  event_id     BIGINT NULL,         -- «В календарь»
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stickers_owner ON stickers (tenant_id, user_id, due_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_stickers_remind ON stickers (due_date, due_time)
  WHERE deleted_at IS NULL AND done_at IS NULL AND due_time IS NOT NULL AND reminded_at IS NULL;

-- Названия цветов у каждого свои («Мысль», «Срочно», …) — переименовывают в легенде.
CREATE TABLE IF NOT EXISTS sticker_prefs (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  color_names JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- утренний список стикеров без времени (пункт 6.2) — последний день, когда отправлен
  digest_on   DATE NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
