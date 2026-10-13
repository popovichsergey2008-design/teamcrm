-- ТЗ-32, §2 «дополнительно»: смена исполнителя, срока, приоритета и проекта — тем же
-- способом, что переходы этапов (0183): пишет триггер, автора дописывает приложение.
-- Создание задачи изменением не считается. Правка одного поля несколько раз за 3 секунды
-- склеивается; вернули как было — запись удаляется.

CREATE TABLE IF NOT EXISTS task_field_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- assignee | deadline | priority | project
  field VARCHAR(16) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_type VARCHAR(16) NOT NULL DEFAULT 'USER',
  assignee_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'AUTOMATION',
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_tfc_tenant_time ON task_field_changes (tenant_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_tfc_task ON task_field_changes (task_id, changed_at DESC);

CREATE OR REPLACE FUNCTION task_log_field_change(t tasks, f VARCHAR, o TEXT, n TEXT) RETURNS void AS $$
DECLARE last RECORD;
BEGIN
  SELECT id, old_value INTO last FROM task_field_changes
   WHERE task_id = t.id AND field = f AND changed_at > clock_timestamp() - interval '3 seconds'
   ORDER BY id DESC LIMIT 1;
  IF FOUND THEN
    IF last.old_value IS NOT DISTINCT FROM n THEN
      DELETE FROM task_field_changes WHERE id = last.id;
    ELSE
      UPDATE task_field_changes SET new_value = n, changed_at = clock_timestamp(), assignee_user_id = t.assignee_id WHERE id = last.id;
    END IF;
    RETURN;
  END IF;
  INSERT INTO task_field_changes (tenant_id, project_id, task_id, field, old_value, new_value, assignee_user_id)
  VALUES (t.tenant_id, t.project_id, t.id, f, o, n, t.assignee_id);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION tasks_log_field_changes() RETURNS trigger AS $$
BEGIN
  IF OLD.assignee_id IS DISTINCT FROM NEW.assignee_id THEN
    PERFORM task_log_field_change(NEW, 'assignee', OLD.assignee_id::text, NEW.assignee_id::text);
  END IF;
  IF OLD.deadline_at IS DISTINCT FROM NEW.deadline_at THEN
    PERFORM task_log_field_change(NEW, 'deadline', OLD.deadline_at::text, NEW.deadline_at::text);
  END IF;
  IF OLD.priority IS DISTINCT FROM NEW.priority THEN
    PERFORM task_log_field_change(NEW, 'priority', OLD.priority::text, NEW.priority::text);
  END IF;
  IF OLD.project_id IS DISTINCT FROM NEW.project_id THEN
    PERFORM task_log_field_change(NEW, 'project', OLD.project_id::text, NEW.project_id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_log_field_changes ON tasks;
CREATE TRIGGER trg_tasks_log_field_changes
  AFTER UPDATE OF assignee_id, deadline_at, priority, project_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_log_field_changes();
