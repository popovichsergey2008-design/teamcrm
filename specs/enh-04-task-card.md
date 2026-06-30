# Enhancements v1 — Этап D. Карточка задачи (Bitrix24-class)

> Часть [трека улучшений](enh-00-master.md). Зависит от Этапа A (вложения → файлы). Самый крупный блок — разбит на под-этапы.

## Цель

Превратить карточку задачи из примитива (название + read-only описание) в полноценное рабочее пространство: rich-text описание, вложения, комментарии с историей изменений, чеклисты, метки, приоритет, наблюдатели. Качество — «как в Bitrix24 или лучше», но без визуального мусора (лёгкий интерфейс — продуктовый инвариант master).

## Текущее состояние

`tasks`: `title`, `description (TEXT)`, `assignee_id`, `status`, `is_blocked`, `estimate_hours`, `deadline_at`, `predicted_finish_at`, `risk_*`, `closed_at`, `cost_current`. UI (TaskDrawer) показывает название (read), описание (read-only), назначение/оценку/дедлайн/таймер/себестоимость/blocked. Нет приоритета, меток, наблюдателей, комментариев, вложений, чеклистов, истории.

## Доменная модель (DDL — миграция `0009`)

```sql
-- Расширение задачи: приоритет (описание уже есть как TEXT, трактуем как markdown).
ALTER TABLE tasks
    ADD COLUMN priority VARCHAR(8) NOT NULL DEFAULT 'normal';  -- low|normal|high|urgent

-- Комментарии к задаче (источник обсуждения; is_client_visible — задел под портал, фича №9).
CREATE TABLE task_comments (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    author_id   BIGINT NOT NULL REFERENCES users(id),
    body        TEXT NOT NULL,
    is_client_visible BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at   TIMESTAMPTZ NULL
);
CREATE INDEX idx_task_comments_task ON task_comments (tenant_id, task_id, created_at);

-- Вложения задачи (ссылается на files из Этапа A).
CREATE TABLE task_attachments (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    file_id     BIGINT NOT NULL REFERENCES files(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (task_id, file_id)
);

-- Чеклисты/подзадачи внутри карточки.
CREATE TABLE task_checklist_items (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    text        VARCHAR(500) NOT NULL,
    is_done     BOOLEAN NOT NULL DEFAULT FALSE,
    position    INT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_checklist_task ON task_checklist_items (tenant_id, task_id, position);

-- Метки/теги (справочник tenant) + связь many-to-many.
CREATE TABLE labels (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    name        VARCHAR(48) NOT NULL,
    color       VARCHAR(16) NOT NULL DEFAULT '#5b8cff',
    UNIQUE (tenant_id, name)
);
CREATE TABLE task_labels (
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    label_id    BIGINT NOT NULL REFERENCES labels(id),
    PRIMARY KEY (task_id, label_id)
);

-- Наблюдатели (получают уведомления об изменениях задачи).
CREATE TABLE task_watchers (
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    PRIMARY KEY (task_id, user_id)
);

-- История изменений задачи (activity log).
CREATE TABLE task_activity (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    task_id     BIGINT NOT NULL REFERENCES tasks(id),
    actor_id    BIGINT NULL REFERENCES users(id),       -- NULL = система/ИИ
    kind        VARCHAR(32) NOT NULL,                   -- created|moved|assigned|commented|attached|checklist|field_changed|...
    detail      JSONB NOT NULL,                         -- {field, from, to, ...}
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_task_activity_task ON task_activity (tenant_id, task_id, created_at);
```

## Контракты

- **Описание** — хранится в `tasks.description` как markdown (rich-text); фронт рендерит/редактирует. Название и описание редактируются через существующий `PATCH /api/tasks/{id}`.
- **Приоритет** — `low|normal|high|urgent`; влияет на сортировку/цвет; меняется через `PATCH`.
- **Комментарии** — CRUD на `/api/tasks/{id}/comments`; автор может править/удалять свой; `is_client_visible` управляет видимостью в будущем портале (по умолчанию internal). Каждый комментарий пишет запись в `task_activity` и уведомляет наблюдателей (очередь `notifications`) + realtime `task.comment_added`.
- **Вложения** — `POST /api/tasks/{id}/attachments` принимает `fileId` (из Этапа A) или multipart (загрузка+привязка одним вызовом); список/удаление; доступ — по доступу к задаче. realtime `task.attachment_added`.
- **Чеклисты** — CRUD пунктов, отметка done, перестановка (`position`). Прогресс (X из Y) — на карточке.
- **Метки** — справочник `labels` (CRUD, owner/manager); назначение/снятие на задаче; цветные на карточке и фильтр доски по метке.
- **Наблюдатели** — добавить/убрать себя или (manager) других; наблюдатели получают уведомления об изменениях; assignee и author — наблюдатели по умолчанию.
- **История** — `task_activity` пишется на ключевые изменения (создание, перенос, назначение, смена полей, комментарий, вложение, чеклист); отдаётся лентой в карточке.
- **Изоляция (фича №9)**: client-представление задачи (будущий портал) отдаёт только client-видимые комментарии и нефинансовые поля; вложения/история с финансовым содержимым — internal. На этом этапе сохраняем флаги и сериализатор, не ломая текущую client-логику board.
- **Реалтайм**: `task.updated`, `task.comment_added`, `task.attachment_added`, `task.checklist_changed` — в комнату проекта (нефинансовые → обе комнаты с учётом client-видимости комментариев).

## Колонки доски (управление, добавлено 2026-06-30)

Колонки (`board_columns`) перестают быть только дефолтными `To Do / In Progress / Done` — owner/manager управляет ими прямо на доске.

- `POST /api/projects/{id}/columns` `{name}` — добавить колонку в конец (position = max+1).
- `PATCH /api/projects/{id}/columns/{colId}` `{name}` — переименовать.
- `POST /api/projects/{id}/columns/{colId}/move` `{direction: left|right}` — переместить (перестановка с соседом; позиции переписываются двухпроходно из-за `UNIQUE(project_id,position)`).
- `POST /api/projects/{id}/columns/reorder` `{orderedIds[]}` — произвольный порядок (drag-and-drop). Сервер валидирует, что набор — точная перестановка текущих колонок (иначе 400).
- `DELETE /api/projects/{id}/columns/{colId}` — удалить; **задачи колонки переносятся в крайнюю левую из оставшихся** (без потери данных, переоткрываются). Нельзя удалить последнюю колонку (409).
- Все мутации — только owner/manager; после изменения летит realtime `column.updated` в комнату проекта → клиенты перезагружают доску.
- **Семантика «Done»**: перенос задачи в колонку закрывает её (Velocity/эмбеддинги) — определяется по имени из набора `{done, готово, выполнено, завершено, закрыто, сделано}` (`isDoneColumn`), чтобы работало и после переименования на русский. Вынос из такой колонки — переоткрывает.
- UI: имя колонки — inline-rename по клику; в шапке колонки кнопки ◀ ▶ (перемещение) и ✕ (удаление, с подтверждением); кнопка «+ колонка» в конце доски. **Перетаскивание колонок мышью за шапку** (drag-and-drop, `dataTransfer` тип `application/x-teamcrm-column` — не конфликтует с перетаскиванием задач `text/plain`; дроп на карточку всплывает к колонке) → `reorder`. Прокрутка списка задач и доски — стилизованные тонкие скроллбары (webkit + `scrollbar-width`).

## API

| Метод | Путь | Назначение |
|---|---|---|
| `PATCH` | `/api/tasks/{id}` | название, описание (md), приоритет, дедлайн и пр. |
| `GET`/`POST` | `/api/tasks/{id}/comments` | список/добавить комментарий |
| `PATCH`/`DELETE` | `/api/tasks/{id}/comments/{cid}` | править/удалить свой комментарий |
| `GET`/`POST` | `/api/tasks/{id}/attachments` | список/прикрепить файл |
| `DELETE` | `/api/tasks/{id}/attachments/{aid}` | открепить/удалить вложение |
| `GET`/`POST` | `/api/tasks/{id}/checklist` | пункты чеклиста |
| `PATCH`/`DELETE` | `/api/tasks/{id}/checklist/{iid}` | отметить/править/удалить пункт |
| `GET`/`POST` | `/api/labels` | справочник меток |
| `POST`/`DELETE` | `/api/tasks/{id}/labels/{labelId}` | назначить/снять метку |
| `POST`/`DELETE` | `/api/tasks/{id}/watchers` | добавить/убрать наблюдателя |
| `GET` | `/api/tasks/{id}/activity` | лента истории изменений |

## Frontend (TaskDrawer → полноценная карточка)

Переработать TaskDrawer в широкую карточку с секциями:
- шапка: название (inline-edit), приоритет (бейдж/селект), метки (чипсы), статус, blocked;
- описание: rich-text редактор (markdown), сохранение;
- вложения: drag-and-drop загрузка, превью/иконки, скачивание/удаление; просмотр — авторизованным fetch (Bearer), картинка в попапе-лайтбоксе, прочее — скачивание (см. [enh-01-files.md → Доступ к файлам с клиента], НЕ прямой `<a href>`/`<img src>` — даёт 401);
- чеклист: пункты с чекбоксами, прогресс-бар, добавление/перестановка;
- правая колонка: исполнитель, наблюдатели (аватары), оценка/дедлайн/прогноз-светофор (из Этапа 4), таймер, себестоимость (internal);
- низ: комментарии (лента + ввод) и история изменений (вкладка/таймлайн).

На канбан-карточке доски показывать: метки (цветные полоски), приоритет, иконку вложений/комментариев со счётчиком, прогресс чеклиста, аватар исполнителя, светофор риска.

## Под-этапы работ

- **D.1.** Миграция `0009`; приоритет + редактирование названия/описания (rich-text) в API и UI.
- **D.2.** Комментарии (CRUD) + `task_activity` (история) + realtime + уведомления наблюдателям.
- **D.3.** Вложения (на базе Этапа A): привязка/список/удаление + UI drag-and-drop.
- **D.4.** Чеклисты (CRUD, прогресс) + UI.
- **D.5.** Метки (справочник + назначение) + наблюдатели + фильтр доски по метке/исполнителю.
- **D.6.** Переработка TaskDrawer в полноценную карточку; обогащение канбан-карточки (метки/приоритет/счётчики/прогресс).
- **D.7.** Тесты: unit (сериализаторы, права на правку чужого комментария), integration/e2e (полный цикл: описание→коммент→вложение→чеклист→метка→наблюдатель→история), security (tenant-изоляция; вложение чужой задачи недоступно; client не видит internal-комментарии/финансы), realtime (события доходят участникам).

## DoD этапа D

В карточке: редактируется название и rich-описание, прикрепляются и скачиваются файлы, ведётся обсуждение с историей изменений, работают чеклисты с прогрессом, метки и приоритет, наблюдатели получают уведомления; всё tenant-изолировано; client не получает internal-комментарии и финансы (фича №9); канбан-карточка отражает метки/приоритет/счётчики/прогресс/светофор; e2e, security и realtime-тесты зелёные.

## Тесты (минимум)

| Группа | Кейсы |
|---|---|
| описание/приоритет | PATCH сохраняет markdown и приоритет; пишется `task_activity` |
| комментарии | CRUD; нельзя править чужой; история и уведомление наблюдателям; realtime-доставка |
| вложения | привязка файла к задаче; скачивание по доступу; чужой tenant — 404; удаление |
| чеклисты | добавить/отметить/пересортировать; прогресс корректен |
| метки/наблюдатели | назначение/снятие; фильтр доски; наблюдатель получает уведомления |
| изоляция (№9) | client не видит internal-комментарии и финансовые поля задачи (REST и WebSocket) |
