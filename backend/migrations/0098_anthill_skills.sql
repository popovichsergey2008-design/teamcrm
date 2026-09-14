-- Навыки AnthillBot (ТЗ-6, разд. 16–19, 59).
--
-- Навык — записанный порядок действий для работы, которую делают регулярно:
-- «еженедельный отчёт по проекту», «подготовка к клиентскому миту». Без него
-- человек каждый раз заново объясняет агенту одно и то же, а результат каждый раз
-- выходит немного другим — и сравнивать отчёты между собой нельзя.
--
-- Навык НЕ даёт новых прав: это подсказка о порядке работы, а данные всё так же
-- берутся инструментами от имени того, кто спросил (разд. 47).
CREATE TABLE ai_skills (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    -- кто завёл; NULL — навык из стартового набора компании
    owner_id    BIGINT NULL REFERENCES users(id),
    name        VARCHAR(120) NOT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    -- «когда использовать»: по этой строке навык и подбирается под запрос
    when_to_use VARCHAR(500) NOT NULL DEFAULT '',
    -- шаги — массив строк: порядок работы, а не код
    steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- что нужно на входе (например, «проект») и каким должен получиться результат
    inputs      JSONB NOT NULL DEFAULT '[]'::jsonb,
    output      VARCHAR(500) NOT NULL DEFAULT '',
    -- private — только автору, company — всей организации
    visibility  VARCHAR(16) NOT NULL DEFAULT 'private',
    -- active | archived
    status      VARCHAR(16) NOT NULL DEFAULT 'active',
    version     INT NOT NULL DEFAULT 1,
    uses        INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_skills_pick ON ai_skills (tenant_id, status);
CREATE UNIQUE INDEX uq_ai_skills_name ON ai_skills (tenant_id, COALESCE(owner_id, 0), lower(name));

-- Стартовый набор (разд. 16): четыре сценария, которые спрашивают чаще всего.
-- Заводим для каждой организации и общими (owner_id NULL): пустой каталог не
-- объясняет, что такое навык, и им никто не начинает пользоваться.
INSERT INTO ai_skills (tenant_id, owner_id, name, description, when_to_use, steps, inputs, output, visibility)
SELECT t.id, NULL,
       'Еженедельный отчёт по проекту',
       'Что сделано за неделю, что застряло и что впереди — одним письмом.',
       'просят отчёт по проекту за неделю, итоги недели, статус проекта',
       '["Собрать задачи проекта, закрытые за последние 7 дней","Собрать задачи в работе и просроченные","Найти решения и договорённости в чате проекта и на митах за неделю","Собрать одним текстом: Сделано · В работе · Риски · Планы на следующую неделю","Сослаться на задачи номерами"]'::jsonb,
       '["проект"]'::jsonb,
       'Короткий отчёт по разделам со ссылками на задачи',
       'company'
  FROM tenants t;

INSERT INTO ai_skills (tenant_id, owner_id, name, description, when_to_use, steps, inputs, output, visibility)
SELECT t.id, NULL,
       'Подготовка к миту',
       'О чём говорить и что спросить — до встречи, а не после.',
       'просят подготовиться к встрече, к созвону, к миту с клиентом',
       '["Найти прошлые миты по этой теме и их итоги","Поднять открытые задачи и договорённости, которые обещали к этой встрече","Найти нерешённые вопросы в переписке по теме","Собрать повестку из 3–6 пунктов и список вопросов"]'::jsonb,
       '["тема встречи или проект"]'::jsonb,
       'Повестка и вопросы к встрече',
       'company'
  FROM tenants t;

INSERT INTO ai_skills (tenant_id, owner_id, name, description, when_to_use, steps, inputs, output, visibility)
SELECT t.id, NULL,
       'Проверка просроченного',
       'Что горит прямо сейчас и что с этим делать.',
       'спрашивают про просроченные задачи, что горит, где мы отстаём',
       '["Собрать просроченные задачи человека и его команды","Сгруппировать по проектам и по тому, насколько просрочено","Для каждой указать, чего она ждёт: исполнителя, решения, согласования","Предложить, что перенести, а что снять"]'::jsonb,
       '[]'::jsonb,
       'Список просроченного с причинами и предложениями',
       'company'
  FROM tenants t;

INSERT INTO ai_skills (tenant_id, owner_id, name, description, when_to_use, steps, inputs, output, visibility)
SELECT t.id, NULL,
       'Задача разработчику',
       'Постановка, по которой можно начать работу, не переспрашивая.',
       'просят поставить задачу разработчику, оформить требование, описать баг',
       '["Уточнить, что именно сломано или что нужно сделать","Собрать описание: что происходит, что должно происходить, где воспроизводится","Добавить чек-лист проверки готовности","Предложить исполнителя и срок"]'::jsonb,
       '["суть задачи"]'::jsonb,
       'Карточка задачи с описанием и чек-листом',
       'company'
  FROM tenants t;
