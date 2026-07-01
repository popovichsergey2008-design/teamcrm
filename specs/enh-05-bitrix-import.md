# Enhancements v1 — Этап E. Импорт досок из Битрикс24 (Задачи)

> Односторонний импорт **Битрикс → наш CRM** через **входящий вебхук**. Сущности — модуль «Задачи» Битрикса (проекты/группы → стадии → задачи). Двусторонняя/живая синхронизация — вне scope этого этапа (заложим точки расширения).

## Решения заказчика (2026-07-01)
- **Что импортируем:** Задачи — `sonet_group` (проект) → `task.stages` (колонки) → `tasks.task` (задачи).
- **Режим:** односторонний импорт (Битрикс → мы), повторяемый (докачивает изменения).
- **Подключение:** входящий вебхук (клиент создаёт его в своём портале, вставляет URL у нас). OAuth-приложение — отдельным этапом позже.

## Цель
Владелец организации подключает свой портал Битрикса (URL вебхука), выбирает проект(ы) и одной кнопкой переносит доску(и) со стадиями, задачами, исполнителями и руководителями в наш CRM. Повторный запуск не плодит дубли, а докатывает изменения.

## Как подключаемся (вебхук)
- В Битриксе: «Разработчикам» → «Другое» → «Входящий вебхук», права минимум `task`, `user`, `sonet_group` (+`disk` для файлов на Этапе E2). Битрикс выдаёт URL вида `https://<portal>.bitrix24.ru/rest/<userId>/<token>/`.
- У нас: владелец вставляет этот URL в «Интеграции → Битрикс24». Проверяем связь методом `profile`/`user.current`.
- URL содержит секрет → **храним зашифрованным** в БД (AES-256-GCM на app-secret из `.env`), в ответах API не отдаём (только «подключено к <portal>»).

## Доменная модель (миграция `0012`)

```sql
-- Подключение интеграции. НЕСКОЛЬКО порталов на одну организацию (разные Битриксы).
CREATE TABLE integration_connections (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    provider      VARCHAR(24) NOT NULL,            -- 'bitrix'
    label         VARCHAR(120) NULL,               -- как назвал клиент («Основной», «Отдел продаж»)
    portal        VARCHAR(255) NULL,               -- домен портала (для отображения)
    webhook_enc   TEXT NOT NULL,                   -- зашифрованный URL вебхука
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_by    BIGINT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    -- нет UNIQUE(tenant,provider): можно подключить несколько порталов;
    -- один и тот же портал дважды отсекаем в сервисе по домену.
);
CREATE INDEX idx_int_conn_tenant ON integration_connections (tenant_id, provider);

-- Карта соответствий внешних объектов локальным (идемпотентность + инкремент).
-- Привязка к КОНКРЕТНОМУ подключению: ID у разных порталов совпадают, поэтому
-- уникальность и поиск — в рамках connection_id, а не провайдера.
CREATE TABLE external_refs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    connection_id BIGINT NOT NULL REFERENCES integration_connections(id),
    entity_type   VARCHAR(24) NOT NULL,            -- project | column | task | user | comment | file
    external_id   VARCHAR(64) NOT NULL,
    local_id      BIGINT NOT NULL,
    external_hash VARCHAR(64) NULL,                -- хеш полей — чтобы пропускать неизменённое
    synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (connection_id, entity_type, external_id)
);
CREATE INDEX idx_external_refs_local ON external_refs (connection_id, entity_type, local_id);

-- Происхождение проекта: свой или импортированный (и из какого подключения).
ALTER TABLE projects ADD COLUMN origin VARCHAR(24) NOT NULL DEFAULT 'local'; -- local | bitrix
ALTER TABLE projects ADD COLUMN origin_connection_id BIGINT NULL REFERENCES integration_connections(id);
CREATE INDEX idx_projects_origin ON projects (tenant_id, origin);

-- Архив сообщений УРОВНЯ ПРОЕКТА (лента группы Битрикса) — чата ещё нет,
-- храним read-only в проекте; при появлении чата — мигрируем сюда/оттуда.
CREATE TABLE imported_messages (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id),
    connection_id  BIGINT NOT NULL REFERENCES integration_connections(id),
    project_id     BIGINT NOT NULL REFERENCES projects(id),
    external_id    VARCHAR(64) NULL,
    author_user_id BIGINT NULL REFERENCES users(id),   -- если сопоставлен по e-mail
    author_label   VARCHAR(160) NULL,                  -- имя из Битрикса, если не сопоставлен
    body           TEXT NOT NULL,
    posted_at      TIMESTAMPTZ NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_imported_messages_project ON imported_messages (tenant_id, project_id, posted_at);

-- Журнал запусков импорта (прогресс/итоги) — по конкретному подключению.
CREATE TABLE import_runs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    connection_id BIGINT NOT NULL REFERENCES integration_connections(id),
    status        VARCHAR(16) NOT NULL DEFAULT 'queued', -- queued|running|done|error
    scope         JSONB NULL,                      -- какие проекты/фильтры
    stats         JSONB NULL,                      -- {projects,columns,tasks,users,skipped}
    error         TEXT NULL,
    started_at    TIMESTAMPTZ NULL,
    finished_at   TIMESTAMPTZ NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

> **Несколько порталов.** `external_refs` уникальна по `(connection_id, entity_type, external_id)` — импорт из портала B никогда не путается с порталом A, даже при совпадающих ID. Пользователи по-прежнему матчатся по e-mail глобально (один человек в двух порталах → один наш аккаунт). Один и тот же портал повторно не подключаем (проверка по домену). Импортированные из разных порталов проекты — это разные проекты у нас.

## Методы Битрикса (REST)
- `user.current` — проверка связи.
- `user.get` (пагинация) — сотрудники (ID, NAME, LAST_NAME, EMAIL) для матчинга.
- `sonet_group.get` — проекты/группы (ID, NAME).
- `task.stages.get` `{entityId: <groupId>}` — стадии канбана группы (ID, TITLE, SORT) → колонки.
- `tasks.task.list` `{filter:{GROUP_ID}, select:[...], start}` — задачи (ID, TITLE, DESCRIPTION, RESPONSIBLE_ID, CREATED_BY, STAGE_ID, STATUS, PRIORITY, DEADLINE, GROUP_ID, CHANGED_DATE, CLOSED_DATE, TAGS), пагинация по 50 (`start`/`next`).
- (E2) комментарии `task.commentitem.getlist`; файлы `UF_TASK_WEBDAV_FILES` → `disk.file.get` → скачиваем в MinIO.
- **Батч**: объединяем до 50 вызовов методом `batch`; учитываем лимит ~2 req/сек — бэкофф на `QUERY_LIMIT_EXCEEDED`.

## Маппинг

| Битрикс | У нас | Примечание |
|---|---|---|
| `sonet_group` | `projects` | имя группы → name |
| `task.stages` (по SORT) | `board_columns` | порядок по SORT; если стадий нет — создаём дефолт To Do/In Progress/Done и раскладываем по STATUS |
| `tasks.task` | `tasks` | TITLE→title, DESCRIPTION→description, STAGE_ID→колонка |
| RESPONSIBLE_ID | `assignee_id` | через матч пользователя |
| CREATED_BY | `created_by` (руководитель) | через матч пользователя |
| PRIORITY (0/1/2) | priority (low/normal/high) | у Битрикса нет «urgent» |
| STATUS=5 / CLOSED_DATE | `closed_at` + колонка Done | завершённые |
| DEADLINE | `deadline_at` | |
| TAGS | `labels` | создаём недостающие метки |
| EMAIL пользователя | матч на `accounts`/`users` | см. ниже |

**Матчинг пользователей:** по `lower(email)`. Есть в нашей организации → берём membership. Нет — задача импортируется **без исполнителя** (или на «заглушку»), несопоставленные показываем владельцу для ручной привязки. Мы **не создаём** молча новых сотрудников (безопасность/лицензии).

## Алгоритм импорта (идемпотентный)
0. Импорт всегда в контексте конкретного `connection_id` (портала); клиент вебхука берёт токен этого подключения; все `external_refs` пишутся с этим `connection_id`.
1. Создать `import_run` (queued) → запустить импорт. **E1: in-process фоновая задача** (endpoint отвечает сразу, статус — через `runs/:id`); вынос в RabbitMQ-воркер — оптимизация для больших порталов (later).
2. Воркер: `user.get` → построить карту email→localUserId (по нашим users; матч глобальный по e-mail, общий для всех порталов).
3. Для каждого выбранного проекта:
   - `external_refs(project)` есть? → тот же локальный проект : создать проект.
   - `task.stages.get` → создать/сопоставить колонки (по SORT), запомнить в `external_refs(column)`.
   - `tasks.task.list` постранично: для каждой задачи — по `external_refs(task)` создать/обновить; `external_hash` не изменился → пропустить. Разложить в колонку по STAGE_ID, проставить исполнителя/руководителя/приоритет/дедлайн/закрытость.
4. Обновлять `import_run.stats`, по завершении — status=done (или error+текст).
5. Реалтайм: по окончании шлём `column.updated`/обновление проектов, чтобы UI подтянул доску.

## API (owner-only)
Несколько подключений → операции над конкретным `:cid` (connection id).
| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/api/integrations/bitrix/connections` `{webhookUrl, label?}` | добавить портал (шифр.) + проверить связь; отсечь дубль по домену |
| `GET` | `/api/integrations/bitrix/connections` | список подключённых порталов (label, portal, активно) |
| `DELETE` | `/api/integrations/bitrix/connections/:cid` | отключить портал (удалить токен) |
| `GET` | `/api/integrations/bitrix/connections/:cid/projects` | список групп этого портала (для выбора) |
| `POST` | `/api/integrations/bitrix/connections/:cid/import` `{projectExternalIds[]}` | запустить импорт (создаёт import_run) |
| `GET` | `/api/integrations/bitrix/runs/:id` | прогресс/итоги запуска |
| `GET` | `/api/integrations/bitrix/connections/:cid/unmatched-users` | несопоставленные пользователи портала |

## Frontend
- Раздел «Интеграции» (у владельца): **список подключённых порталов** + кнопка «Добавить портал» (URL вебхука + название). У каждого портала: список его проектов Битрикса с чекбоксами, кнопка «Импортировать», индикатор прогресса (poll `runs/:id`), несопоставленные пользователи, «Отключить».

## Свои vs импортированные проекты
- `projects.origin` = `local` (создан у нас) / `bitrix` (импортирован). При импорте проставляем `origin='bitrix'` + `origin_connection_id`.
- UI: у импортированного проекта в сайдбаре — бейдж «⤓ <label портала>»; в списке проектов возможен фильтр «Свои / Импортированные». В шапке доски — «импортировано из <портал>».
- Структура импортируется 1-в-1: группа Битрикса (напр. «Медицина») → проект с тем же именем → все её стадии как колонки → задачи разложены по колонкам согласно стадии. Своя доска и импортированная живут рядом, не смешиваются.

## Сообщения проекта (лента группы) — куда кладём без чата
- Комментарии **к задачам** → `task_comments` (ниже, E1).
- Сообщения **уровня проекта** (лента/посты группы Битрикса, не привязанные к задаче) → таблица-архив `imported_messages`, привязанная к проекту. Показываем **read-only** в проекте (панель «Лента (импорт)»), автор — по e-mail либо подпись из Битрикса. Идемпотентность через `external_refs(entity_type='message')`. Когда появится модуль чата — эти записи станут основой/мигрируют в него.
- Fetch ленты группы (`log.blogpost.get`/feed) тяжелее task-комментариев → **само получение в E2**, но модель хранения фиксируем сейчас.

## Комментарии задач (в E1)
- `task.commentitem.getlist` / `task.commentitem.get` — по каждой задаче: `AUTHOR_ID`, `POST_MESSAGE`, `POST_DATE`.
- Пишем в существующую `task_comments` (Этап D): текст→body, POST_DATE→created_at, автор — матч по e-mail на нашего пользователя.
- Несопоставленный автор → сохраняем текст с префиксом «[Импортировано из Битрикса, автор: <Имя>]», без создания пользователя.
- Идемпотентность: `external_refs (entity_type='comment')` — повторный импорт не задваивает.
- Файлы внутри комментариев — на E2 (перекачка Bitrix Disk → MinIO).

## Этапность внутри E
- **E1.** Подключение (шифр. хранение, тест связи, **несколько порталов**) + импорт структуры (проект `origin='bitrix'` → колонки → задачи: исполнитель/руководитель/приоритет/дедлайн/закрытость) **+ комментарии задач** + теги→метки; идемпотентно по подключению, воркер+прогресс, матч по e-mail. Frontend: экран «Интеграции» + бейдж импортированного проекта.
- **E2.** Вложения (Bitrix Disk → MinIO), в т.ч. файлы в комментариях; **лента проекта → `imported_messages`** (панель «Лента (импорт)»); экран ручной привязки несопоставленных пользователей.
- **E3 (позже, отдельно).** Живой инкремент по исходящим событиям Битрикса; затем — двусторонняя; затем — OAuth-приложение и CRM-воронки.

## Безопасность
- Вебхук-URL (секрет) — только зашифрованным в БД, в API не возвращаем; действия — только `owner`.
- Импорт строго в рамках своего `tenant_id`; внешние ID изолированы по арендатору.
- Валидация URL (только `https`, домен `*.bitrix24.*` или заданный self-hosted), таймауты, лимит объёма.

## Тесты / DoD
- Unit: маппинг полей (приоритет/статус/стадии), матчинг e-mail, шифрование токена, идемпотентность (повторный импорт не плодит дубли — проверка `external_refs`).
- e2e (мок Битрикс-REST): connect→projects→import→доска у нас соответствует; повторный import обновляет, не дублирует; несопоставленный исполнитель → задача без assignee и попадает в unmatched.
- e2e комментарии: комментарии задачи импортированы в `task_comments` (текст/дата/автор по e-mail), несопоставленный автор — с префиксом; повторный импорт не задваивает.
- DoD E1: владелец подключил вебхук, выбрал проект, получил у нас идентичную доску (колонки+задачи+исполнитель/руководитель **+ комментарии + теги**), повторный импорт идемпотентен; секрет зашифрован; всё под owner-guard; CI зелёный.
