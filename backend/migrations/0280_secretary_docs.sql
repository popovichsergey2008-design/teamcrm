-- #1476 (замена живого секретаря, функции F20, F11, F21, F24 из таблицы Бориса).
--
-- doc_deadlines   — сроки личных и рабочих документов (паспорт, виза, полис, договор):
--                   секретарь напоминает за 30/7/1 день и в день окончания. Номеров
--                   документов НЕ храним — только название и дату: напоминанию номер не
--                   нужен, а персональные данные в базе — лишний риск.
-- client_dates    — важные даты клиента (день рождения контакта, день компании, годовщина
--                   сотрудничества): накануне ответственному — карточка с черновиком поздравления.
-- contract_reviews — проверка договора: результат по файлу, чтобы повторное открытие
--                   не тратило модель.
-- receipts        — чеки для авансового отчёта: фото/PDF → распознанные поля → Excel.

CREATE TABLE doc_deadlines (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        VARCHAR(16) NOT NULL DEFAULT 'other',   -- passport|visa|insurance|contract|license|other
    title       VARCHAR(160) NOT NULL,
    expires_on  DATE NOT NULL,
    remind_days INT[] NOT NULL DEFAULT '{30,7,1}',
    reminded    INT[] NOT NULL DEFAULT '{}',              -- уже напомнили: пороги в днях, -1 = «истёк»
    note        VARCHAR(500) NULL,
    renewed_at  TIMESTAMPTZ NULL,                         -- «Продлил» — напоминания прекращаются
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_doc_deadlines_user ON doc_deadlines (tenant_id, user_id, expires_on);
CREATE INDEX idx_doc_deadlines_open ON doc_deadlines (expires_on) WHERE renewed_at IS NULL;

CREATE TABLE client_dates (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    client_id   BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id  BIGINT NULL REFERENCES client_contacts(id) ON DELETE SET NULL,
    kind        VARCHAR(16) NOT NULL DEFAULT 'birthday', -- birthday|company|partnership|other
    title       VARCHAR(160) NULL,
    month       SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
    day         SMALLINT NOT NULL CHECK (day BETWEEN 1 AND 31),
    year        SMALLINT NULL,                            -- для годовщин: «5 лет сотрудничества»
    created_by  BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_client_dates_client ON client_dates (tenant_id, client_id);
CREATE INDEX idx_client_dates_day ON client_dates (month, day);

CREATE TABLE contract_reviews (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    file_id     BIGINT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    result      JSONB NOT NULL,
    model       VARCHAR(80) NULL,
    created_by  BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, file_id)
);

CREATE TABLE receipts (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id     BIGINT NULL REFERENCES files(id) ON DELETE SET NULL,
    status      VARCHAR(12) NOT NULL DEFAULT 'new',       -- new|recognized|failed|manual
    spent_on    DATE NULL,
    seller      VARCHAR(200) NULL,
    seller_inn  VARCHAR(16) NULL,
    total       NUMERIC(14,2) NULL,
    vat         NUMERIC(14,2) NULL,
    currency    VARCHAR(3) NOT NULL DEFAULT 'RUB',
    category    VARCHAR(32) NULL,
    purpose     VARCHAR(300) NULL,
    error       VARCHAR(300) NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_receipts_user ON receipts (tenant_id, user_id, spent_on);
