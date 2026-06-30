# Enhancements v1 — Этап B. Управление командой (должности, группы/отделы, участники)

> Часть [трека улучшений](enh-00-master.md). Роли RBAC (owner/manager/member/client) сохраняются как модель ПРАВ; должности и группы — организационные атрибуты поверх ролей.

## Цель

Дать owner/manager полноценное управление командой: приглашать/создавать сотрудников, назначать **должность** (из справочника), включать в **группы/отделы** (плоские), менять роль/должность/группы, деактивировать/восстанавливать. Сотрудник видит свою команду (справочник коллег) в рамках tenant.

## Текущее состояние

`users` (tenant_id, email, full_name, role_id, is_active, weekly_capacity_hours). `POST /api/users` создаёт сотрудника (email+пароль+роль), `GET /api/users` — список. Нет должностей, групп, приглашений, деактивации через API, нет редактирования сотрудника админом.

## Доменная модель (DDL — миграция `0007`)

```sql
-- Справочник должностей (свободно настраивается tenant'ом).
CREATE TABLE positions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    name        VARCHAR(96) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

-- Группы/отделы (плоские, без вложенности). kind различает отдел и произвольную группу.
CREATE TABLE groups (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    name        VARCHAR(96) NOT NULL,
    kind        VARCHAR(16) NOT NULL DEFAULT 'group',  -- department | group
    lead_user_id BIGINT NULL REFERENCES users(id),     -- руководитель (опционально)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

-- Членство в группах (many-to-many).
CREATE TABLE user_groups (
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    user_id     BIGINT NOT NULL REFERENCES users(id),
    group_id    BIGINT NOT NULL REFERENCES groups(id),
    PRIMARY KEY (user_id, group_id)
);
CREATE INDEX idx_user_groups_group ON user_groups (tenant_id, group_id);

-- Должность сотрудника.
ALTER TABLE users
    ADD COLUMN position_id BIGINT NULL REFERENCES positions(id);

-- Приглашения (без зависимости от SMTP: одноразовая ссылка-токен).
CREATE TABLE invites (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    email       VARCHAR(255) NOT NULL,
    role_code   VARCHAR(32) NOT NULL,
    position_id BIGINT NULL REFERENCES positions(id),
    token_hash  VARCHAR(255) NOT NULL,             -- хранится только хэш
    invited_by  BIGINT NOT NULL REFERENCES users(id),
    expires_at  TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (token_hash)
);
```

## Контракты

- **Должности** — CRUD справочника (owner/manager). Должность присваивается пользователю (`users.position_id`).
- **Группы/отделы** — CRUD (owner/manager); плоские; у группы опционально руководитель (`lead_user_id`); пользователь состоит в нескольких группах.
- **Добавление сотрудника** — два пути:
  1. **Прямое создание** (как сейчас): admin задаёт email/имя/пароль/роль/должность/группы.
  2. **Приглашение по ссылке**: admin создаёт invite → backend выдаёт одноразовый токен (ссылку); приглашённый открывает ссылку, задаёт пароль и имя → создаётся `user` с заданными ролью/должностью; токен одноразовый и истекает. (Без SMTP — ссылку admin передаёт сам; e-mail-доставка — отдельно, когда появится SMTP.)
- **Управление участником** (owner/manager): сменить роль, должность, набор групп, деактивировать (`is_active=false`) / восстановить. Деактивированный не логинится; его задачи не теряются.
- **Видимость**: список команды и оргсправочник видны всем internal-ролям своего tenant; управление — только owner/manager; `client` — нет доступа.
- **Инварианты**: нельзя удалить/деактивировать последнего `owner`; роль `client` не назначается через team-управление (это внешний заказчик, Этап 5).

## API

| Метод | Путь | Назначение | Доступ |
|---|---|---|---|
| `GET`/`POST` | `/api/positions` | справочник должностей | list: internal; create: owner/manager |
| `PATCH`/`DELETE` | `/api/positions/{id}` | правка/удаление должности | owner/manager |
| `GET`/`POST` | `/api/groups` | группы/отделы | list: internal; create: owner/manager |
| `PATCH`/`DELETE` | `/api/groups/{id}` | правка/удаление, назначение руководителя | owner/manager |
| `POST` | `/api/groups/{id}/members` | добавить/убрать участника | owner/manager |
| `GET` | `/api/users` | список сотрудников (с должностью, группами, статусом) | internal |
| `POST` | `/api/users` | создать сотрудника (роль/должность/группы) | owner/manager |
| `PATCH` | `/api/users/{id}` | сменить роль/должность/группы/активность | owner/manager |
| `POST` | `/api/invites` | создать приглашение → одноразовая ссылка | owner/manager |
| `POST` | `/api/invites/accept` | принять приглашение (token + пароль + имя) | public |

## Frontend

- Расширить панель «Команда»: вкладки **Сотрудники** (список с должностью/группами/статусом, действия: пригласить, создать, редактировать, деактивировать), **Должности** (CRUD), **Группы/отделы** (CRUD + участники + руководитель).
- Карточка сотрудника: имя, email, роль, должность, группы, статус; кнопки управления (owner/manager).
- Экран принятия приглашения (`/invite?token=...`): ввод имени и пароля.

## Этапы работ

- **B.1.** Миграция `0007`; модули `positions`, `groups`; CRUD + tenant-scope + RBAC.
- **B.2.** Расширение `users`: `position_id`, `PATCH /api/users/{id}` (роль/должность/группы/активность) с инвариантами (последний owner, запрет client).
- **B.3.** Приглашения: создание токена, accept-флоу (public), одноразовость/истечение.
- **B.4.** Frontend: вкладки «Сотрудники/Должности/Группы», карточка сотрудника, экран принятия инвайта.
- **B.5.** Тесты: unit (инварианты ролей), integration/e2e (создание/инвайт/смена должности и групп, деактивация), security (member не управляет командой; tenant-изоляция справочников; client — 403).

## DoD этапа B

Owner/manager создаёт справочник должностей и групп, добавляет сотрудника (прямо и по одноразовой ссылке), назначает роль/должность/группы, деактивирует; нельзя убрать последнего owner; справочники tenant-изолированы; member видит команду, но не управляет; e2e и security-тесты зелёные.

## Тесты (минимум)

| Группа | Кейсы |
|---|---|
| должности/группы | CRUD; tenant-изоляция (B не видит справочники A); уникальность имени в tenant |
| участники | смена роли/должности/групп; деактивация блокирует логин; запрет деактивации последнего owner |
| приглашения | accept создаёт пользователя с заданной ролью/должностью; токен одноразовый и истекает |
| RBAC | member/ client не управляют командой (403); список команды — internal-роли |
