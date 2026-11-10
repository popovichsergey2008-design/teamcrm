-- #4846: подзадачи как в Битрикс24 — у задачи может быть одна родительская.
-- Родителя удалили насовсем — подзадачи остаются самостоятельными задачами.
-- Круги (A под B, B под A) запрещает код: проверка идёт вверх по цепочке родителей.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_parent_not_self;
ALTER TABLE tasks ADD CONSTRAINT tasks_parent_not_self CHECK (parent_task_id IS NULL OR parent_task_id <> id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;
