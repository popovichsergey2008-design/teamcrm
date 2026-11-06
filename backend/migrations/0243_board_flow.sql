-- #4798 / #4799: доска и карточка — проверяющий, препятствия, зависимости, сдачи на
-- проверку версиями, сохранённые виды, порог «в работе» и простые правила.
--
-- Ничего из этого не двигает и не закрывает задачи само: препятствие и связь —
-- пометки, сдача — запись о результате, правило — только уведомление.

-- Кто проверяет результат. Пусто — постановщик, как было до сих пор.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reviewer_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL;

/*
  Препятствие: почему работа стоит, что нужно и кто может помочь. Одно открытое на
  задачу; снятое остаётся в истории. Признак tasks.is_blocked держим в согласии с ним —
  на нём уже стоят фильтры, отчёты и переходы этапов (ТЗ-32).
*/
CREATE TABLE IF NOT EXISTS task_blockers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- wait_answer | no_access | no_info | depends | other
  reason VARCHAR(16) NOT NULL,
  need TEXT NOT NULL DEFAULT '',
  helper_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  next_step TEXT NOT NULL DEFAULT '',
  due_on DATE NULL,
  created_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL,
  resolved_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  resolve_note TEXT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_blockers_open ON task_blockers (task_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_task_blockers_helper ON task_blockers (tenant_id, helper_id) WHERE resolved_at IS NULL;

/*
  Зависимость: task_id ждёт завершения depends_on_id. Циклы запрещает сервис (проверка
  обходом графа перед вставкой). notified_at — «можно приступать» уже сказали.
*/
CREATE TABLE IF NOT EXISTS task_links (
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_task_links_dep ON task_links (depends_on_id);

/*
  Сдача результата на проверку. Каждая сдача — новая версия: проверяющий принимает
  именно ту, которую читал (если пришла новая — просим перечитать), а решение по
  версии записывается один раз.
*/
CREATE TABLE IF NOT EXISTS task_handoffs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version INT NOT NULL,
  author_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  done_text TEXT NOT NULL DEFAULT '',
  where_text TEXT NOT NULL DEFAULT '',
  limits_text TEXT NOT NULL DEFAULT '',
  reviewer_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- accepted | returned
  decision VARCHAR(16) NULL,
  decided_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NULL,
  decision_note TEXT NULL,
  UNIQUE (task_id, version)
);

/*
  Сохранённый вид доски: имя и условия отбора. Личный видит только автор, общий —
  все, кто видит проект; задачи в нём всё равно отбираются по правам смотрящего.
*/
CREATE TABLE IF NOT EXISTS board_views (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  query JSONB NOT NULL DEFAULT '{}'::jsonb,
  shared BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_board_views_project ON board_views (tenant_id, project_id);

-- Мягкий порог «в работе на человека»: пусто — не следим. Только предупреждение.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS wip_limit INT NULL;

/*
  Простые правила «Когда X — тогда Y». Действие — только уведомление или напоминание:
  автоархив, автозакрытие и перенос намеренно не предусмотрены.
*/
CREATE TABLE IF NOT EXISTS board_rules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- handed_to_review | returned | deadline_soon | dependency_done | accepted
  trigger VARCHAR(24) NOT NULL,
  -- notify_reviewer | notify_creator | notify_assignee | notify_watchers | notify_dependents
  action VARCHAR(24) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, trigger, action)
);

-- Журнал срабатываний; event_key — защита от повтора одного события.
CREATE TABLE IF NOT EXISTS board_rule_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id BIGINT NOT NULL REFERENCES board_rules(id) ON DELETE CASCADE,
  task_id BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL,
  event_key VARCHAR(160) NOT NULL,
  recipients INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_board_rule_runs_rule ON board_rule_runs (rule_id, created_at DESC);

/*
  Согласование результата клиентом по ссылке. Видно только выбранное: текст результата,
  отмеченные файлы. Ссылку владелец задачи может отозвать.
*/
CREATE TABLE IF NOT EXISTS task_share_links (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  token VARCHAR(64) NOT NULL UNIQUE,
  created_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  summary TEXT NOT NULL DEFAULT '',
  result_text TEXT NOT NULL DEFAULT '',
  file_ids BIGINT[] NOT NULL DEFAULT '{}',
  revoked_at TIMESTAMPTZ NULL,
  -- approved | changes
  decision VARCHAR(16) NULL,
  decision_note TEXT NULL,
  decided_at TIMESTAMPTZ NULL,
  guest_name VARCHAR(120) NULL
);
CREATE INDEX IF NOT EXISTS idx_task_share_links_task ON task_share_links (task_id);
