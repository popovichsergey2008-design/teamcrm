-- Шаблоны задач (просьба заказчика: «кнопка сохранить как шаблон»).
--
-- Зачем. Одни и те же задачи ставятся заново каждую неделю и каждому новому клиенту:
-- «запустить рекламу», «подключить домен», «собрать отчёт». Название, описание,
-- чек-лист и привычный исполнитель у них одинаковые, и всё это набирают руками —
-- по-разному, с потерями, и часть шагов забывается.
--
-- Что храним. Ровно то, что человек увидит в форме новой задачи, — без срока датой:
-- у шаблона нет «15 сентября», у него есть «через неделю». Поэтому deadline_days.
--
-- Шаблон — на организацию, а не на человека: смысл в том, чтобы коллега поставил
-- задачу так же, как её поставили бы вы.
CREATE TABLE IF NOT EXISTS task_templates (
    id               BIGSERIAL PRIMARY KEY,
    tenant_id        BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- Как шаблон называется в списке: «Еженедельный отчёт», а не название задачи.
    name             TEXT        NOT NULL,
    title            TEXT        NOT NULL,
    description      TEXT        NOT NULL DEFAULT '',
    priority         TEXT        NOT NULL DEFAULT 'normal',
    -- Кто обычно это делает. Ушёл из компании — поле обнуляется, шаблон живёт.
    assignee_id      BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    estimate_hours   NUMERIC     NULL,
    -- Не завершать без согласования: свойство работы, а не конкретной задачи.
    requires_approval BOOLEAN    NOT NULL DEFAULT TRUE,
    -- Срок относительный: «через N дней от постановки». NULL — срок не назначается.
    deadline_days    INT         NULL,
    -- Пункты чек-листа строками: ['Проверить домен', 'Выпустить сертификат'].
    checklist        JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- Теги: те же метки, что у задач (см. 0127). Удалённый тег просто исчезает
    -- из списка при применении — за целостностью следит выборка, а не внешний ключ.
    label_ids        JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_by       BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    -- Сколько раз по нему завели задачу: по этому числу видно живые шаблоны.
    used_count       INT         NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Список шаблонов организации: частые сверху, остальные по алфавиту (сортировка в коде).
CREATE INDEX IF NOT EXISTS task_templates_tenant_idx ON task_templates (tenant_id, name);

-- Два шаблона с одним именем — это всегда ошибка: человек не поймёт, какой из них его.
CREATE UNIQUE INDEX IF NOT EXISTS task_templates_name_uniq
    ON task_templates (tenant_id, lower(name));
