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

-- Стартовый набор (разд. 16) заводится КОДОМ при первом открытии каталога
-- (STARTER_SKILLS в anthill.service). В миграции его нет намеренно: организации
-- создаются каждый день, и набор, вписанный сюда один раз, достался бы только тем,
-- кто существовал в день выкладки.
