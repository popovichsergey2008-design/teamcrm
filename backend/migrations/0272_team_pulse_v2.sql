-- #4890 ТЗ «Пульс команды: что внедрить».
-- Разбор решений по одной карточке с «Отменить», пересказ сданной работы, «Пульс недели»
-- в Telegram и события для метрик. Индекс v2 считается из задач и журнала переходов —
-- своей таблицы ему не нужно.

-- пп. 4–6: каждое решение разбора и снимок задачи до него — «Отменить» возвращает всё как было
CREATE TABLE IF NOT EXISTS decision_actions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- один разбор (пачка из 10) — для итога «10 решений за 14 минут»
  run_id VARCHAR(40) NULL,
  item_key VARCHAR(40) NOT NULL,
  task_id BIGINT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  approval_id BIGINT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  -- accept | return | ask | close
  action VARCHAR(16) NOT NULL,
  snapshot JSONB NOT NULL DEFAULT '{}',
  note TEXT NULL,
  -- «Задать вопрос»: сообщение, которое удаляет «Отменить»
  comment_id BIGINT NULL,
  index_before NUMERIC(5,1) NULL,
  index_after NUMERIC(5,1) NULL,
  count_before INT NULL,
  count_after INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_actions_user ON decision_actions (tenant_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_actions_run ON decision_actions (run_id) WHERE run_id IS NOT NULL;

-- п. 5: «Кратко от ИИ» — пересказ живёт, пока в задаче не поменялись вложения, чек-лист и чат
CREATE TABLE IF NOT EXISTS decision_recaps (
  task_id BIGINT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facts_key VARCHAR(16) NOT NULL,
  text TEXT NOT NULL,
  -- ai | rules
  source VARCHAR(8) NOT NULL DEFAULT 'rules',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- п. 12: «Пульс недели» — можно отключить или перенести; нет строки — понедельник 9:00
CREATE TABLE IF NOT EXISTS pulse_weekly_prefs (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- 0 — воскресенье … 6 — суббота, как Date#getDay
  weekday SMALLINT NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
  at_time VARCHAR(5) NOT NULL DEFAULT '09:00',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- одна сводка на человека в неделю, даже если процессов API несколько
CREATE TABLE IF NOT EXISTS pulse_weekly_sends (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_key DATE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week_key)
);

-- «Как поймём, что сработало»: действия из Пульса, отправки и открытия «Пульса недели»
CREATE TABLE IF NOT EXISTS pulse_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  -- action | weekly_sent | weekly_open | run_started | run_finished
  kind VARCHAR(24) NOT NULL,
  ref VARCHAR(64) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pulse_events_kind ON pulse_events (tenant_id, kind, created_at);
