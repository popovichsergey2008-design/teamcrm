/*
  Версии сущностей и журнал изменений (ТЗ-9, волна 9 — offline).

  Телефон, работавший без сети, привозит правки «на вчерашнюю версию». Чтобы не
  затирать молча то, что за это время поменяли другие, у задачи есть номер версии:
  клиент присылает `If-Match: <version>`, сервер сверяет и при расхождении отвечает 409
  с текущим состоянием — человек видит оба варианта и решает сам.

  Журнал изменений — для delta-sync: «что поменялось после моей последней записи».
  Хранит только ссылки (тип, id, операция, версия), не содержимое: содержимое клиент
  берёт обычными ручками со всеми их правами. Пишется триггерами: тогда его не обойти
  ни импортом, ни вебхуком, ни забытым сервисом.
*/
ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE change_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- курсор
    tenant_id   BIGINT NOT NULL,
    entity_type VARCHAR(24) NOT NULL,      -- task | task_comment | chat_message | checklist_item
    entity_id   BIGINT NOT NULL,
    parent_id   BIGINT NULL,               -- проект у задачи, задача у комментария, чат у сообщения
    op          VARCHAR(8)  NOT NULL,      -- insert | update | delete
    version     INTEGER NULL,
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_change_log_tenant ON change_log (tenant_id, id);

CREATE OR REPLACE FUNCTION tasks_bump_version() RETURNS trigger AS $$
BEGIN
    -- Версия растёт на каждом содержательном изменении, каким бы путём оно ни пришло.
    -- Сдвиг позиции соседей при переносе чужой карточки — не содержательное: иначе
    -- правка названия с телефона упиралась бы в 409 из-за того, что кто-то двигал доску.
    IF (to_jsonb(OLD) - 'position' - 'updated_at' - 'version')
       IS DISTINCT FROM (to_jsonb(NEW) - 'position' - 'updated_at' - 'version') THEN
        NEW.version := COALESCE(OLD.version, 0) + 1;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_tasks_bump_version BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION tasks_bump_version();

CREATE OR REPLACE FUNCTION change_log_tasks() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO change_log (tenant_id, entity_type, entity_id, parent_id, op, version)
        VALUES (OLD.tenant_id, 'task', OLD.id, OLD.project_id, 'delete', OLD.version);
        RETURN OLD;
    END IF;
    INSERT INTO change_log (tenant_id, entity_type, entity_id, parent_id, op, version)
    VALUES (NEW.tenant_id, 'task', NEW.id, NEW.project_id, lower(TG_OP), NEW.version);
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_change_log_tasks AFTER INSERT OR UPDATE OR DELETE ON tasks
    FOR EACH ROW EXECUTE FUNCTION change_log_tasks();

CREATE OR REPLACE FUNCTION change_log_task_comments() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO change_log (tenant_id, entity_type, entity_id, parent_id, op)
        VALUES (OLD.tenant_id, 'task_comment', OLD.id, OLD.task_id, 'delete');
        RETURN OLD;
    END IF;
    INSERT INTO change_log (tenant_id, entity_type, entity_id, parent_id, op)
    VALUES (NEW.tenant_id, 'task_comment', NEW.id, NEW.task_id, lower(TG_OP));
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_change_log_task_comments AFTER INSERT OR UPDATE OR DELETE ON task_comments
    FOR EACH ROW EXECUTE FUNCTION change_log_task_comments();

CREATE OR REPLACE FUNCTION change_log_chat_messages() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO change_log (tenant_id, entity_type, entity_id, parent_id, op)
        VALUES (OLD.tenant_id, 'chat_message', OLD.id, OLD.chat_id, 'delete');
        RETURN OLD;
    END IF;
    INSERT INTO change_log (tenant_id, entity_type, entity_id, parent_id, op)
    VALUES (NEW.tenant_id, 'chat_message', NEW.id, NEW.chat_id, lower(TG_OP));
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_change_log_chat_messages AFTER INSERT OR UPDATE OR DELETE ON chat_messages
    FOR EACH ROW EXECUTE FUNCTION change_log_chat_messages();

CREATE OR REPLACE FUNCTION change_log_checklist() RETURNS trigger AS $$
DECLARE t BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT tenant_id INTO t FROM tasks WHERE id = OLD.task_id;
        IF t IS NOT NULL THEN
            INSERT INTO change_log (tenant_id, entity_type, entity_id, parent_id, op)
            VALUES (t, 'checklist_item', OLD.id, OLD.task_id, 'delete');
        END IF;
        RETURN OLD;
    END IF;
    SELECT tenant_id INTO t FROM tasks WHERE id = NEW.task_id;
    IF t IS NOT NULL THEN
        INSERT INTO change_log (tenant_id, entity_type, entity_id, parent_id, op)
        VALUES (t, 'checklist_item', NEW.id, NEW.task_id, lower(TG_OP));
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_change_log_checklist AFTER INSERT OR UPDATE OR DELETE ON task_checklist_items
    FOR EACH ROW EXECUTE FUNCTION change_log_checklist();