-- Централизованная система безопасности (ТЗ «Central Security System»).
--
-- До сих пор права жили в коде: «клиент не мутирует задачи», «интеграции — только
-- владелец», «удалять задачи может каждый». Пока компания одна и все друг друга
-- знают, этого хватает. Дальше — нет: владелец должен сам решать, кто что видит и
-- может, и уметь ограничить даже своего администратора.
--
-- Главное правило всего слоя: решение принимает СЕРВЕР. Спрятанная кнопка и
-- замазанное поле в интерфейсе — не защита, их обходит любой, кто открыл вкладку
-- «сеть» в браузере.

-- Роли организации: базовые (владелец, руководитель, сотрудник, клиент) заводятся
-- кодом, свои — компанией. Права хранятся набором, а не колонками: их десятки, и
-- каждая новая возможность продукта иначе означала бы миграцию.
CREATE TABLE IF NOT EXISTS security_roles (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code        TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    -- Базовую роль нельзя удалить: на ней держится вход в систему.
    is_base     BOOLEAN     NOT NULL DEFAULT FALSE,
    -- {"task.delete": {"allowed": true, "scope": "created_by_me"}}
    permissions JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_by  BIGINT      NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, code)
);

-- Своя роль человека поверх базовой. NULL — работает базовая.
ALTER TABLE users ADD COLUMN IF NOT EXISTS security_role_id BIGINT NULL REFERENCES security_roles(id) ON DELETE SET NULL;

-- Индивидуальные поправки к правам ОДНОГО человека.
--
-- Ради этого и затевалось: «этот администратор делает всё, кроме контактов и
-- интеграций». Поправка сильнее роли — и в плюс, и в минус, но её не может выдать
-- тот, у кого самого этого права нет (потолок проверяется в коде).
CREATE TABLE IF NOT EXISTS user_permission_overrides (
    tenant_id  BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT        NOT NULL,
    allowed    BOOLEAN     NOT NULL,
    -- Насколько широко действует право: all | department | project | assigned |
    -- created_by_me | none. NULL — как в роли.
    scope      TEXT        NULL,
    updated_by BIGINT      NULL REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, permission)
);

-- Политика безопасности организации одним документом: двухфакторка, контакты,
-- интеграции, сессии, мобильные правила. Одним JSON, потому что это именно НАБОР
-- правил, который будет расти, а не таблица сущностей.
CREATE TABLE IF NOT EXISTS security_policies (
    tenant_id  BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    config     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    updated_by BIGINT      NULL REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Журнал безопасности: кто, что, над чем и откуда. Только добавление — правок и
-- удалений нет ни у кого, включая владельца: журнал, который можно почистить, не
-- отвечает на единственный вопрос, ради которого он нужен.
CREATE TABLE IF NOT EXISTS security_audit (
    id             BIGSERIAL PRIMARY KEY,
    tenant_id      BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    actor_user_id  BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    -- Имя на момент события: сотрудник может уйти, а запись должна остаться читаемой.
    actor_name     TEXT        NULL,
    event_type     TEXT        NOT NULL,
    resource_type  TEXT        NULL,
    resource_id    TEXT        NULL,
    target_user_id BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    ip             TEXT        NULL,
    device_id      TEXT        NULL,
    metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_audit_tenant_idx ON security_audit (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS security_audit_event_idx ON security_audit (tenant_id, event_type, created_at DESC);

-- Раскрытия контактов: отдельной таблицей, а не только в общем журнале.
-- По ним строится отчёт «кто смотрел контакты» и действует срок повторного скрытия.
CREATE TABLE IF NOT EXISTS contact_reveals (
    id         BIGSERIAL PRIMARY KEY,
    tenant_id  BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id  BIGINT      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    field      TEXT        NOT NULL,
    reason     TEXT        NULL,
    ip         TEXT        NULL,
    device_id  TEXT        NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_reveals_tenant_idx ON contact_reveals (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS contact_reveals_user_idx ON contact_reveals (tenant_id, user_id, created_at DESC);

-- Контакты клиента по полям.
--
-- Было одно поле «контакт» строкой — в нём вперемешку телефон, почта и «спросить у
-- Пети». Закрывать такое нельзя: непонятно, что именно закрываешь. Разводим по
-- полям, старое значение остаётся как заметка.
ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS phone    VARCHAR(64)  NULL,
    ADD COLUMN IF NOT EXISTS email    VARCHAR(160) NULL,
    ADD COLUMN IF NOT EXISTS telegram VARCHAR(64)  NULL;

-- Мягкое удаление задач: «Корзина» вместо исчезновения навсегда.
--
-- Удалённая по ошибке задача до сих пор уносила с собой обсуждение, файлы и историю.
-- Теперь она уходит в корзину, и её видно только тем, у кого есть право
-- восстанавливать; окончательное удаление — отдельное право, по умолчанию у владельца.
ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS deleted_by BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS delete_reason TEXT     NULL;
CREATE INDEX IF NOT EXISTS tasks_deleted_idx ON tasks (tenant_id, deleted_at) WHERE deleted_at IS NOT NULL;
