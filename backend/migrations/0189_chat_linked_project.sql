-- Проект группы/канала (20.10): задачи из переписки чата ставятся в этот проект.
-- Отдельная колонка, а не chats.project_id: та уникальна и означает «чат самого проекта»
-- (kind='project'); у одного проекта может быть сколько угодно групп и каналов.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS linked_project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS chats_linked_project_idx ON chats (linked_project_id) WHERE linked_project_id IS NOT NULL;
