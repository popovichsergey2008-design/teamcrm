-- Администрирование AnthillBot и квоты (ТЗ-6, разд. 52–53).
--
-- Одна строка на организацию: что агенту позволено и сколько ему можно. Держим
-- вместе, потому что решения связаны: выключить веб-поиск и оставить его лимит
-- бессмысленно, а разбирать это по трём таблицам — значит каждый раз собирать
-- картину заново.
--
-- Лимиты — в JSON, а не колонками: их список будет меняться (ТЗ прямо говорит «не
-- привязываться к конкретным коммерческим лимитам»), и каждая новая строчка не
-- должна стоить миграции.
CREATE TABLE ai_agent_settings (
    tenant_id       BIGINT PRIMARY KEY REFERENCES tenants(id),
    -- агент целиком: выключенный отвечает понятной фразой, а не молчанием
    enabled         BOOLEAN NOT NULL DEFAULT true,
    -- кому доступен: коды ролей. Клиент не входит сюда никогда — у него свой портал
    allowed_roles   JSONB NOT NULL DEFAULT '["owner","manager","member"]'::jsonb,
    -- внешний веб-поиск: по умолчанию ВЫКЛЮЧЕН (разд. 26 — агент работает на данных CRM)
    web_search      BOOLEAN NOT NULL DEFAULT false,
    web_search_key  TEXT NULL,                       -- ключ провайдера, шифрованный
    -- чтение вложений и сборка документов
    files_allowed   BOOLEAN NOT NULL DEFAULT true,
    -- пишущие инструменты (создать задачу, напомнить, изменить). Выключено — агент
    -- только отвечает, карточек действий не предлагает
    actions_allowed BOOLEAN NOT NULL DEFAULT true,
    -- внешние интеграции как инструменты (письма, встречи)
    integrations    BOOLEAN NOT NULL DEFAULT false,
    -- {requestsPerDay, deepPerDay, maxScheduled, maxSkills, contextMessages}
    limits          JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by      BIGINT NULL REFERENCES users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
