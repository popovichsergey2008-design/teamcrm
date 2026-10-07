-- ТЗ-17. Раздел «Клиенты»: из тонкой записи «название + контакт» — рабочий центр
-- отношений с клиентом.
--
-- Расширяем существующую таблицу clients, а не заводим новую: её уже знают портал
-- (users.client_id), проекты (projects.client_id), внешние чаты (chats.client_id),
-- сделки и журнал показа контактов. Вторая «сущность клиента» рядом развела бы данные.

-- ── клиент ──────────────────────────────────────────────────────────────────────
ALTER TABLE clients
    ADD COLUMN type               VARCHAR(12)  NOT NULL DEFAULT 'company',  -- company | person
    ADD COLUMN legal_name         VARCHAR(255) NULL,
    -- lead · active · paused · inactive · lost (архив — отдельным полем archived_at)
    ADD COLUMN status             VARCHAR(16)  NOT NULL DEFAULT 'active',
    ADD COLUMN segment            VARCHAR(48)  NULL,
    ADD COLUMN source             VARCHAR(32)  NULL,
    ADD COLUMN owner_user_id      BIGINT       NULL REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN department_id      BIGINT       NULL REFERENCES groups(id) ON DELETE SET NULL,  -- отдел (groups)
    ADD COLUMN website            VARCHAR(255) NULL,
    -- домен без www — для поиска дублей
    ADD COLUMN domain             VARCHAR(160) NULL,
    ADD COLUMN country            VARCHAR(80)  NULL,
    ADD COLUMN city               VARCHAR(120) NULL,
    ADD COLUMN address            VARCHAR(400) NULL,
    ADD COLUMN tax_id             VARCHAR(32)  NULL,
    ADD COLUMN registration_number VARCHAR(48) NULL,
    ADD COLUMN description        TEXT         NULL,
    -- название без ООО/LLC, кавычек и регистра — для поиска дублей
    ADD COLUMN normalized_name    VARCHAR(255) NULL,
    ADD COLUMN created_by         BIGINT       NULL REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    ADD COLUMN archived_at        TIMESTAMPTZ  NULL,
    -- последнее значимое событие по клиенту (п. 41)
    ADD COLUMN last_activity_at   TIMESTAMPTZ  NULL,
    -- следующее действие (п. 42): что, когда и откуда взялось
    ADD COLUMN next_action        VARCHAR(255) NULL,
    ADD COLUMN next_action_at     TIMESTAMPTZ  NULL,
    ADD COLUMN next_action_source VARCHAR(16)  NULL;  -- manual | task | meeting | deal

UPDATE clients SET normalized_name = lower(regexp_replace(name, '[«»"''`.,]', '', 'g')),
                   last_activity_at = created_at;

CREATE INDEX idx_clients_list ON clients (tenant_id, archived_at, status);
CREATE INDEX idx_clients_owner ON clients (tenant_id, owner_user_id);
CREATE INDEX idx_clients_activity ON clients (tenant_id, last_activity_at DESC);
CREATE INDEX idx_clients_name_trgm ON clients USING gin (normalized_name gin_trgm_ops);
CREATE INDEX idx_clients_domain ON clients (tenant_id, domain) WHERE domain IS NOT NULL;
CREATE INDEX idx_clients_tax ON clients (tenant_id, tax_id) WHERE tax_id IS NOT NULL;

-- ── контактные лица ─────────────────────────────────────────────────────────────
CREATE TABLE client_contacts (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id         BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    first_name        VARCHAR(120) NOT NULL,
    last_name         VARCHAR(120) NULL,
    position          VARCHAR(160) NULL,
    phone             VARCHAR(64)  NULL,
    -- телефон цифрами в виде +79991234567 — для поиска и дублей
    phone_norm        VARCHAR(24)  NULL,
    email             VARCHAR(160) NULL,
    email_norm        VARCHAR(160) NULL,
    telegram          VARCHAR(64)  NULL,
    whatsapp          VARCHAR(64)  NULL,
    preferred_channel VARCHAR(16)  NULL,  -- phone | email | telegram | whatsapp
    is_primary        BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    archived_at       TIMESTAMPTZ  NULL
);
CREATE INDEX idx_client_contacts_client ON client_contacts (client_id) WHERE archived_at IS NULL;
CREATE INDEX idx_client_contacts_email ON client_contacts (tenant_id, email_norm) WHERE email_norm IS NOT NULL;
CREATE INDEX idx_client_contacts_phone ON client_contacts (tenant_id, phone_norm) WHERE phone_norm IS NOT NULL;
-- основной контакт у клиента один (п. 25)
CREATE UNIQUE INDEX uq_client_primary_contact ON client_contacts (client_id)
    WHERE is_primary AND archived_at IS NULL;

-- Прежние телефон/email/telegram/«контакт» клиента — первое контактное лицо, основное.
INSERT INTO client_contacts (tenant_id, client_id, first_name, phone, phone_norm, email, email_norm, telegram, is_primary)
SELECT c.tenant_id, c.id,
       COALESCE(NULLIF(left(trim(c.contact), 120), ''), 'Основной контакт'),
       c.phone,
       NULLIF(regexp_replace(COALESCE(c.phone, ''), '[^0-9+]', '', 'g'), ''),
       c.email, lower(trim(c.email)), c.telegram, TRUE
  FROM clients c
 WHERE COALESCE(c.phone, c.email, c.telegram, c.contact) IS NOT NULL;

-- журнал показа контактов знает и контактное лицо, а не только клиента
ALTER TABLE contact_reveals ADD COLUMN contact_id BIGINT NULL REFERENCES client_contacts(id) ON DELETE SET NULL;

-- ── команда клиента (п. 44) ─────────────────────────────────────────────────────
CREATE TABLE client_members (
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id  BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- account · sales · pm · support · watcher
    role       VARCHAR(16) NOT NULL DEFAULT 'watcher',
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, user_id)
);
CREATE INDEX idx_client_members_user ON client_members (tenant_id, user_id);

-- ── заметки (п. 39) ─────────────────────────────────────────────────────────────
CREATE TABLE client_notes (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id   BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    author_id   BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    body        TEXT NOT NULL,
    pinned      BOOLEAN NOT NULL DEFAULT FALSE,
    -- личная: видят автор и руководство
    is_private  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ NULL
);
CREATE INDEX idx_client_notes_client ON client_notes (client_id, created_at DESC) WHERE deleted_at IS NULL;

-- ── лента событий (п. 40) ───────────────────────────────────────────────────────
-- Пишутся события самого клиента (создан, контакт, заметка, сделка, файл, показ
-- контакта). Задачи, встречи и переписка подмешиваются в ленту запросом из своих
-- таблиц — копий сообщений здесь нет (п. 34).
CREATE TABLE client_activity (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id   BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    actor_id    BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    -- client · contact · note · deal · file · reveal · task · meeting · project
    kind        VARCHAR(16) NOT NULL,
    title       VARCHAR(300) NOT NULL,
    entity_type VARCHAR(16) NULL,
    entity_id   BIGINT NULL,
    detail      JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_client_activity ON client_activity (client_id, created_at DESC);

-- ── файлы клиента (п. 38) ───────────────────────────────────────────────────────
CREATE TABLE client_files (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id   BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    file_id     BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    -- contract · invoice · proposal · presentation · technical · other
    category    VARCHAR(16) NOT NULL DEFAULT 'other',
    uploaded_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_client_files ON client_files (client_id, created_at DESC);

-- ── сохранённые виды списка (п. 78) ─────────────────────────────────────────────
CREATE TABLE client_saved_views (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        VARCHAR(80) NOT NULL,
    filter_json JSONB NOT NULL DEFAULT '{}',
    sort_json   JSONB NOT NULL DEFAULT '{}',
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_client_views_user ON client_saved_views (tenant_id, user_id);

-- ── сделки: то, что нужно блоку в карточке (п. 29) ──────────────────────────────
ALTER TABLE deals
    ADD COLUMN owner_user_id  BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN currency       VARCHAR(3) NOT NULL DEFAULT 'RUB',
    ADD COLUMN probability    SMALLINT NULL CHECK (probability BETWEEN 0 AND 100),
    ADD COLUMN next_action    VARCHAR(255) NULL,
    ADD COLUMN close_date     DATE NULL,
    ADD COLUMN lost_reason    VARCHAR(300) NULL,
    ADD COLUMN archived_at    TIMESTAMPTZ NULL;
-- стадии — стандартный список (решение заказчика); прежняя «new» остаётся «new»
CREATE INDEX idx_deals_client ON deals (tenant_id, client_id) WHERE archived_at IS NULL;

-- ── прямые связи с клиентом (решение заказчика: задача — и не только через проект) ──
ALTER TABLE tasks ADD COLUMN client_id BIGINT NULL REFERENCES clients(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_client ON tasks (tenant_id, client_id) WHERE client_id IS NOT NULL;
ALTER TABLE calendar_events ADD COLUMN client_id BIGINT NULL REFERENCES clients(id) ON DELETE SET NULL;
CREATE INDEX idx_events_client ON calendar_events (tenant_id, client_id) WHERE client_id IS NOT NULL;
ALTER TABLE meetings ADD COLUMN client_id BIGINT NULL REFERENCES clients(id) ON DELETE SET NULL;
