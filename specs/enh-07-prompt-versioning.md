# Enhancements — PromptOps: версионирование промптов

> «Git для инструкций ИИ». Вся ИИ-логика (промпты) выносится из кода в версионируемое хранилище: тест, откат, A/B, метрики, аудит — без релиза приложения. Фундамент ИИ-нативной архитектуры (см. [vision-ai-native-crm.md](vision-ai-native-crm.md)).

## Проблема

Сейчас промпты **захардкожены** в коде:
- `brain.service.ts` → `SYSTEM` (инструкция «корпоративного разума»);
- `ai.provider.ts` → schema-hint парсера стендапа;
- будущие: «создай задачу из письма», «еженедельный отчёт», «приоритизация багов».

Любое улучшение промпта = правка кода + релиз. Нельзя: быстро откатиться при регрессии, сравнить версии (A/B), измерить качество, дать не-разработчику подкрутить формулировку, адаптировать под нишу клиента.

## Что такое «версия промпта»

Версия — это не только текст, а воспроизводимый набор:
- **body** — текст инструкции (с плейсхолдерами `{{var}}`);
- **model** — целевая модель (gpt-4o-mini / claude-3-5-sonnet / …), т.к. один промпт работает по-разному на разных моделях;
- **params** — temperature, top_p, max_tokens;
- **variables** — объявленные переменные (что подставляется);
- **status** — draft | testing | active | deprecated.

## Доменная модель (миграция `0019`)

```sql
-- Шаблон промпта (ключ фичи). Глобальные дефолты: tenant_id IS NULL.
CREATE TABLE prompt_templates (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NULL REFERENCES tenants(id),   -- NULL = системный дефолт для всех
    key         VARCHAR(64) NOT NULL,                 -- 'brain.system' | 'standup.parse' | 'task.from_email' ...
    title       VARCHAR(160) NOT NULL,
    description TEXT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);

CREATE TABLE prompt_versions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    template_id  BIGINT NOT NULL REFERENCES prompt_templates(id),
    version      INT NOT NULL,                        -- 1,2,3…
    body         TEXT NOT NULL,
    model        VARCHAR(64) NULL,                    -- переопределяет модель для этого промпта
    params       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {temperature, top_p, max_tokens}
    variables    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ["question","context"]
    status       VARCHAR(16) NOT NULL DEFAULT 'draft',-- draft|testing|active|deprecated
    ab_split     INT NULL,                            -- % трафика на этот вариант (для testing A/B)
    note         TEXT NULL,                           -- что изменено
    created_by   BIGINT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (template_id, version)
);
CREATE INDEX idx_prompt_versions_tpl ON prompt_versions (template_id, status);

-- Привязка расхода к версии промпта (метрики/A-B) — расширяем метеринг.
ALTER TABLE ai_usage ADD COLUMN prompt_version_id BIGINT NULL REFERENCES prompt_versions(id);

-- Обратная связь по результату версии (аудит качества).
CREATE TABLE prompt_feedback (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         BIGINT NOT NULL REFERENCES tenants(id),
    prompt_version_id BIGINT NOT NULL REFERENCES prompt_versions(id),
    rating            SMALLINT NOT NULL,              -- +1 (👍) | -1 (👎)
    reworked          BOOLEAN NOT NULL DEFAULT FALSE, -- потребовалась переделка
    user_id           BIGINT NULL REFERENCES users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_prompt_feedback_ver ON prompt_feedback (prompt_version_id);
```

**Инвариант «одна активная версия»** на шаблон — обеспечивается сервисом (при активации версии остальные active→deprecated). A/B: одна `active` + одна `testing` с `ab_split`.

## Рендер и приоритет

`PromptService.resolve(tenantId, key, variables)`:
1. Найти шаблон: **tenant override > глобальный дефолт** (по `key`).
2. Выбрать версию:
   - если есть `testing` с `ab_split` → детерминированно по `hash(userId|requestId)` в пределах split вернуть A(active) или B(testing);
   - иначе — `active`.
3. Интерполировать `{{var}}` из `variables` (недостающие → пусто, лишние игнор).
4. Вернуть `{ body, model, params, versionId, variant }`.

Результат передаётся в `AiService.generate/parse`, а `versionId` пишется в `ai_usage.prompt_version_id` → метрики по версии.

## Интеграция с существующим ИИ-слоем

- **Вынести захардкоженные промпты** в глобальные дефолты (сид в миграции, `tenant_id=NULL`, версия 1 = текущий текст):
  - `brain.system` — системный промпт «корпоративного разума» (сейчас `SYSTEM` в brain.service);
  - `standup.parse` — schema-hint парсера (сейчас в ai.provider).
- `AiService.generate(tenantId, key, variables, feature)` — новая перегрузка: сама достаёт промпт через `PromptService.resolve`, использует его `model`/`params` (переопределяют BYOK-модель), маскирует PII (без изменений), пишет `ai_usage` с `prompt_version_id`.
- BYOK-модель остаётся дефолтом; `prompt_versions.model` — точечное переопределение под конкретный промпт.
- Кэш Brain (K3) — ключ кэша включает `versionId` (смена версии → свежий ответ).

## API (owner/manager)

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/api/prompts` | список шаблонов (+активная версия, статус) |
| `GET` | `/api/prompts/:key/versions` | все версии шаблона |
| `POST` | `/api/prompts/:key/versions` `{body, model?, params?, note?}` | новая версия (draft); авто-инкремент номера |
| `POST` | `/api/prompts/:key/versions/:v/activate` | сделать активной (откат = активировать старую) |
| `POST` | `/api/prompts/:key/versions/:v/ab` `{split}` | пометить testing со split% (A/B) |
| `POST` | `/api/prompts/:key/versions/:v/deprecate` | вывести из оборота |
| `GET` | `/api/prompts/:key/metrics?days=` | метрики по версиям: вызовы, токены, стоимость, доля 👍, доля переделок |
| `POST` | `/api/prompt-feedback` `{promptVersionId, rating, reworked?}` | оценка результата |

Права: чтение/правка промптов — owner/manager (доменная логика). Глобальные дефолты правит только суперадмин платформы (или клонируются как tenant override — клиент правит свою копию, не системную).

## Frontend

Раздел **«Интеграции → ИИ → Промпты»** (или отдельная вкладка «Промпты»):
- список шаблонов с активной версией и статус-бейджами (active ⭐ / testing 🧪 / deprecated);
- редактор версии: текст (с подсветкой `{{переменных}}`), выбор модели (из доступных по ключу — переиспользуем `GET /ai/settings/models`), params;
- кнопки: «Сохранить как новую версию», «Сделать активной» (=откат для старой), «A/B (split %)», «Вывести из оборота»;
- **история версий** с автором/датой/note и метриками (вызовы, токены, стоимость, 👍/👎, % переделок);
- сравнение результатов side-by-side (P3).
- В AI Brain — кнопки 👍/👎 под ответом → `prompt-feedback` (аудит качества).

## Этапы

- **P1 (ядро).** Хранилище (`prompt_templates`/`prompt_versions`) + `PromptService.resolve` (tenant>global, интерполяция) + вынос `brain.system` и `standup.parse` в дефолты + `ai_usage.prompt_version_id` + API (list/versions/create/activate/deprecate) + UI (список/редактор/история/активация-откат). Даёт **безопасное обновление и откат без релиза**.
- **P2 (метрики + аудит).** `prompt_feedback` (👍/👎, переделки) + `GET /prompts/:key/metrics` (по версиям) + UI-дашборд. Даёт **«видно, какая версия лучше»**.
- **P3 (A/B).** `testing`+`ab_split`, детерминированный сплит в `resolve`, сравнение метрик A vs B, side-by-side. Плюс **ниши**: tenant-override под отрасль (`brain.system` для «Недвижимость»).
- **P4 (Pro).** Авто-оптимизация (ИИ предлагает улучшенный промпт по метрикам), стоимость-осознанный выбор модели, автоматическая оценка качества результатов.

## Аналогия (для интерфейса и документации)

| Разработка кода | PromptOps |
|---|---|
| Git commits | версии промпта |
| Code review | оценка результата (👍/👎) |
| Production / Staging | active / testing |
| Rollback | активировать старую версию |
| A/B testing | split между версиями |
| Feature flags | tenant-override / ниши |

## Тесты / DoD

- unit: интерполяция `{{var}}`; выбор версии (active; testing+split — детерминированность по ключу); приоритет tenant>global.
- e2e: создать версию → активировать → `resolve` возвращает её; **откат** (активировать старую) → `resolve` возвращает старую; смена `brain.system` → ответ Brain использует новый системный промпт; изоляция по tenant (правки одного не видит другой); `ai_usage.prompt_version_id` проставляется; feedback пишется и агрегируется в метриках.
- **DoD P1:** промпты Brain/стендапа вынесены в версионируемое хранилище; owner меняет/откатывает версию **без релиза**, изменение сразу влияет на ответы ИИ; активная версия одна; расход метерится по версии; всё scoped по tenant; CI зелёный.

## Безопасность

- Промпты — это **инструкции**, не данные пользователя; маскирование PII применяется к подставляемым `variables` на egress `AiService` (без изменений).
- Правка промптов — owner/manager; системные дефолты (`tenant_id=NULL`) не редактируются клиентом напрямую — клонируются в tenant-override.
- Инъекции: `variables` подставляются как значения плейсхолдеров, не как исполняемые инструкции; для RAG-контекста сохраняется разграничение «system vs user».
