-- Enhancements enh-07, PromptOps (P1): версионируемое хранилище промптов ИИ.
-- «Git для инструкций ИИ»: текст промптов уходит из кода в БД — тест/откат/A-B/метрики без релиза.

-- Шаблон промпта (ключ фичи). Глобальные системные дефолты: tenant_id IS NULL.
CREATE TABLE prompt_templates (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NULL REFERENCES tenants(id),   -- NULL = системный дефолт для всех арендаторов
    key         VARCHAR(64) NOT NULL,                 -- 'brain.system' | 'standup.parse' | ...
    title       VARCHAR(160) NOT NULL,
    description TEXT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);
-- Уникальность глобального ключа (tenant_id IS NULL) — частичный индекс, т.к. UNIQUE не ловит NULL.
CREATE UNIQUE INDEX uq_prompt_templates_global_key ON prompt_templates (key) WHERE tenant_id IS NULL;

CREATE TABLE prompt_versions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    template_id  BIGINT NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
    version      INT NOT NULL,                         -- 1,2,3…
    body         TEXT NOT NULL,                        -- текст инструкции (плейсхолдеры {{var}})
    model        VARCHAR(64) NULL,                     -- точечное переопределение модели
    params       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {temperature, top_p, max_tokens}
    variables    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ["question","context"]
    status       VARCHAR(16) NOT NULL DEFAULT 'draft', -- draft|testing|active|deprecated
    ab_split     INT NULL,                             -- % трафика на этот вариант (testing A/B)
    note         TEXT NULL,                            -- что изменено
    created_by   BIGINT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (template_id, version)
);
CREATE INDEX idx_prompt_versions_tpl ON prompt_versions (template_id, status);

-- Привязка расхода к версии промпта (метрики/A-B) — расширяем метеринг.
ALTER TABLE ai_usage ADD COLUMN prompt_version_id BIGINT NULL REFERENCES prompt_versions(id);
CREATE INDEX idx_ai_usage_prompt_version ON ai_usage (prompt_version_id) WHERE prompt_version_id IS NOT NULL;

-- Семантический кэш ответов Brain (K3) скоупится версией промпта: смена версии → свежий ответ,
-- а не старый из кэша (ключ кэша включает versionId).
ALTER TABLE ai_answer_cache ADD COLUMN prompt_version_id BIGINT NULL REFERENCES prompt_versions(id);

-- Обратная связь по результату версии (аудит качества; используется в P2).
CREATE TABLE prompt_feedback (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         BIGINT NOT NULL REFERENCES tenants(id),
    prompt_version_id BIGINT NOT NULL REFERENCES prompt_versions(id),
    rating            SMALLINT NOT NULL,               -- +1 (👍) | -1 (👎)
    reworked          BOOLEAN NOT NULL DEFAULT FALSE,  -- потребовалась переделка
    user_id           BIGINT NULL REFERENCES users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_prompt_feedback_ver ON prompt_feedback (prompt_version_id);

-- ── Сид глобальных дефолтов (tenant_id NULL, версия 1 = текущий захардкоженный текст) ──

-- brain.system — системный промпт «корпоративного разума» (был в brain.service.ts SYSTEM).
WITH t AS (
    INSERT INTO prompt_templates (tenant_id, key, title, description)
    VALUES (NULL, 'brain.system', 'AI Brain — системный промпт',
            'Инструкция «корпоративного разума»: отвечать строго по RAG-контексту и ссылаться на источники [n].')
    RETURNING id
)
INSERT INTO prompt_versions (template_id, version, body, params, status, note)
SELECT t.id, 1,
$body$Ты — «корпоративный разум» компании: отвечаешь новым и текущим сотрудникам на основе архива задач, комментариев и регламентов. Отвечай ТОЛЬКО на основе предоставленного КОНТЕКСТА. Если в контексте нет ответа — честно скажи, что в базе знаний не нашлось материалов, и не выдумывай. Дай чёткий пошаговый ответ на русском. Ссылайся на источники в квадратных скобках, например [1], [2], соответствующих номерам в контексте.$body$,
       '{"max_tokens": 1500}'::jsonb, 'active', 'Начальная версия (вынос из кода)'
FROM t;

-- standup.parse — schema-hint парсера стендапа (был в ai.provider.ts).
WITH t AS (
    INSERT INTO prompt_templates (tenant_id, key, title, description)
    VALUES (NULL, 'standup.parse', 'AI Standup — парсер интентов',
            'Инструкция парсера дейликов: вернуть строгий JSON действий по задачам.')
    RETURNING id
)
INSERT INTO prompt_versions (template_id, version, body, params, status, note)
SELECT t.id, 1,
$body$Верни СТРОГО JSON {"actions":[{"task_id":number,"status_change":"DONE|IN_PROGRESS|TODO","time_logged_minutes":number,"blocker_detected":string}],"confidence":0..1}. Только JSON, без пояснений.$body$,
       '{"max_tokens": 1024}'::jsonb, 'active', 'Начальная версия (вынос из кода)'
FROM t;
