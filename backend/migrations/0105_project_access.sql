-- Правка проекта и видимость «для своих» + участники проекта.
--
-- Чего не хватало (просьба заказчика): проект нельзя было переименовать, а доска
-- любого проекта была видна всей компании. Второе — не мелочь: бухгалтерия, найм и
-- работа с конкретным клиентом лежат в тех же досках, и «видно всем» тут неверно.
--
-- Устройство самое простое из работающих: у проекта два состояния видимости.
--   all     — видят все сотрудники (как было раньше, и это по-прежнему умолчание);
--   members — видят только перечисленные люди, ответственный за проект и руководство.
-- Роли owner и manager видят всё всегда: иначе руководитель теряет из виду работу,
-- за которую отвечает, и восстановить доступ будет некому.
ALTER TABLE projects
    ADD COLUMN visibility VARCHAR(16) NOT NULL DEFAULT 'all';

-- Кому открыт проект с видимостью «members». Для 'all' таблица не используется:
-- список участников там не имеет смысла и только вводил бы в заблуждение.
CREATE TABLE project_members (
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

-- Спрашивают в двух направлениях: «кто в проекте» и «какие проекты видит человек».
CREATE INDEX idx_project_members_user ON project_members (tenant_id, user_id);
