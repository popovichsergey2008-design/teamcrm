-- Руководитель/постановщик задачи (по умолчанию — создатель). Исполнитель = assignee_id.
ALTER TABLE tasks ADD COLUMN created_by BIGINT NULL REFERENCES users(id);
CREATE INDEX idx_tasks_created_by ON tasks (tenant_id, created_by);
