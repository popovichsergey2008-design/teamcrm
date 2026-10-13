-- ТЗ-32: журнал переходов задач между этапами — источник правды для счётчиков
-- «на тестирование / возвращено / в готовое / переоткрыто» в «Пульсе команды».
--
-- Пишет ТРИГГЕР, а не приложение: колонку задачи меняют и перенос на доске, и приёмка,
-- и возврат на доработку, и синхронизация с YouGile/Битрикс, и удаление колонки — путь,
-- которого нет в журнале, давал бы дыру в цифрах. Автора и источник база не знает —
-- их дописывает приложение сразу после изменения (stamp), иначе — «автоматика».
--
-- Этап — тот же, что везде (task_stage, ТЗ-30), плюс «заблокирована» поверх него.
-- Перенос в той же колонке или между колонками одного этапа переходом не считается.
--
-- Склейка: перенос задачи — несколько запросов подряд (колонка, закрытие, приёмка),
-- и база видит промежуточные шаги («в Готово» → «ждёт приёмки»). Переход той же задачи
-- в пределах 3 секунд дописывается в последнюю запись; вернулось в исходный этап —
-- запись удаляется. Историю до этой миграции не восстанавливаем (§30).

CREATE TABLE IF NOT EXISTS task_status_transitions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_column_id BIGINT REFERENCES board_columns(id) ON DELETE SET NULL,
  to_column_id BIGINT REFERENCES board_columns(id) ON DELETE SET NULL,
  from_stage VARCHAR(24) NOT NULL,
  to_stage VARCHAR(24) NOT NULL,
  -- кто изменил (человек); у действий ИИ — тот, кто его запустил (triggered_by)
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  -- USER | SYSTEM_AGENT
  actor_type VARCHAR(16) NOT NULL DEFAULT 'USER',
  -- чья задача в момент перехода
  assignee_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  -- MANUAL | AI | AUTOMATION | API | IMPORT
  source VARCHAR(16) NOT NULL DEFAULT 'AUTOMATION',
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_tst_tenant_time ON task_status_transitions (tenant_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_tst_project_time ON task_status_transitions (tenant_id, project_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_tst_task ON task_status_transitions (task_id, changed_at DESC);

CREATE OR REPLACE FUNCTION task_effective_stage(col BIGINT, approval VARCHAR, closed TIMESTAMPTZ, blocked BOOLEAN)
RETURNS VARCHAR AS $$
  SELECT CASE
    WHEN closed IS NOT NULL THEN 'done'
    WHEN COALESCE(blocked, false) THEN 'blocked'
    ELSE task_stage(col, approval, closed)
  END
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION tasks_log_transition() RETURNS trigger AS $$
DECLARE
  old_stage VARCHAR := task_effective_stage(OLD.column_id, OLD.approval_state, OLD.closed_at, OLD.is_blocked);
  new_stage VARCHAR := task_effective_stage(NEW.column_id, NEW.approval_state, NEW.closed_at, NEW.is_blocked);
  last RECORD;
BEGIN
  IF old_stage = new_stage THEN RETURN NEW; END IF;

  SELECT id, from_stage INTO last FROM task_status_transitions
   WHERE task_id = NEW.id AND changed_at > clock_timestamp() - interval '3 seconds'
   ORDER BY id DESC LIMIT 1;

  IF FOUND THEN
    IF last.from_stage = new_stage THEN
      DELETE FROM task_status_transitions WHERE id = last.id;
    ELSE
      UPDATE task_status_transitions
         SET to_stage = new_stage, to_column_id = NEW.column_id, project_id = NEW.project_id,
             assignee_user_id = NEW.assignee_id, changed_at = clock_timestamp()
       WHERE id = last.id;
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO task_status_transitions
    (tenant_id, project_id, task_id, from_column_id, to_column_id, from_stage, to_stage, assignee_user_id)
  VALUES (NEW.tenant_id, NEW.project_id, NEW.id, OLD.column_id, NEW.column_id, old_stage, new_stage, NEW.assignee_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_log_transition ON tasks;
CREATE TRIGGER trg_tasks_log_transition
  AFTER UPDATE OF column_id, approval_state, closed_at, is_blocked ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_log_transition();
