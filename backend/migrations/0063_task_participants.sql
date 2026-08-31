-- Соисполнители и наблюдатели задачи.
--
-- До сих пор у задачи было ровно два человека: исполнитель и постановщик. В жизни
-- работу часто делают вдвоём, а следят за ней трое — и всё это держалось в комментариях
-- либо в голове. Из-за этого задача не попадала в «Мои задачи» тому, кто её фактически
-- делает, и уведомления шли мимо тех, кому они нужны.
--
-- Основной исполнитель остаётся в `tasks.assignee_id` намеренно: он один, с него
-- спрашивают, по нему считается загрузка и скорость. Здесь — те, кто рядом.
CREATE TABLE task_participants (
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    task_id    BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id),
    -- co_assignee — делает работу вместе с исполнителем;
    -- watcher — следит и получает уведомления, но задачу не выполняет
    role       VARCHAR(16) NOT NULL,
    added_by   BIGINT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, task_id, user_id, role)
);

-- «Мои задачи» и уведомления ищут по человеку: он спрашивает «что на мне»,
-- а не «кто в этой задаче».
CREATE INDEX idx_task_participants_user ON task_participants (tenant_id, user_id, role);
CREATE INDEX idx_task_participants_task ON task_participants (tenant_id, task_id);
