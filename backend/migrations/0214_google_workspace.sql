-- #1565 Google Workspace: Диск, Документы, Календарь — по OAuth человека.
--
-- Раньше (0079) календарь связывали с Google ссылками .ics, без OAuth, — и честно писали,
-- что записи в чужой календарь так не бывает. Заказчик попросил полную интеграцию:
-- прикреплять файлы с Диска, создавать документы и класть наши встречи в Google Календарь.
-- Подключение ЛИЧНОЕ: каждый даёт доступ к своему Google, и только к нему.
--
-- Главный принцип (§124 ТЗ): QEVO не копирует Диск и Календарь, а связывает их файлы
-- и события с задачами, проектами, клиентами и встречами. Сам файл живёт в Google.

-- Подключённый аккаунт. Один на человека: второй Google у одного сотрудника — путаница,
-- «куда ушла встреча». Сменить аккаунт = отключить и подключить заново.
CREATE TABLE google_accounts (
    id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id                BIGINT NOT NULL REFERENCES tenants(id),
    user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    google_sub               VARCHAR(64) NOT NULL,      -- постоянный id аккаунта Google
    email                    VARCHAR(255) NOT NULL,
    display_name             VARCHAR(255) NULL,
    -- токены только шифрованными (AES-256-GCM, IntegrationCryptoService); наружу не отдаются
    access_token_enc         TEXT NULL,
    refresh_token_enc        TEXT NULL,
    access_token_expires_at  TIMESTAMPTZ NULL,
    scopes                   TEXT[] NOT NULL DEFAULT '{}',
    -- active | attention (Google отозвал доступ — нужно переподключить)
    status                   VARCHAR(16) NOT NULL DEFAULT 'active',
    last_error               TEXT NULL,
    connected_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id)
);

-- Одноразовый state для входа через Google: защита от подмены (CSRF). Живёт 10 минут.
CREATE TABLE google_oauth_states (
    state       VARCHAR(64) PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants(id),
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service     VARCHAR(16) NOT NULL,                 -- drive | calendar | all
    return_to   VARCHAR(255) NULL,                    -- куда вернуть человека после согласия
    expires_at  TIMESTAMPTZ NOT NULL
);

-- Файл Google, привязанный к сущности QEVO. Одна универсальная связь на все разделы (§43).
-- Отвязка удаляет строку, а не файл в Google (§44).
CREATE TABLE google_drive_links (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id        BIGINT NOT NULL REFERENCES tenants(id),
    entity_type      VARCHAR(16) NOT NULL,            -- task | project | client | event
    entity_id        BIGINT NOT NULL,
    google_file_id   VARCHAR(128) NOT NULL,
    file_name        VARCHAR(500) NOT NULL,
    mime_type        VARCHAR(160) NOT NULL,
    web_view_link    TEXT NOT NULL,
    icon_link        TEXT NULL,
    owner_name       VARCHAR(255) NULL,
    modified_time    TIMESTAMPTZ NULL,
    -- создан из QEVO (документ по шаблону) или прикреплён готовый
    origin           VARCHAR(16) NOT NULL DEFAULT 'picked',
    created_by       BIGINT NOT NULL REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (entity_type IN ('task', 'project', 'client', 'event')),
    UNIQUE (tenant_id, entity_type, entity_id, google_file_id)
);
CREATE INDEX idx_google_drive_links_entity ON google_drive_links (tenant_id, entity_type, entity_id);

-- Настройки календаря человека: в какой календарь класть наши встречи и класть ли вообще.
CREATE TABLE google_calendar_settings (
    user_id               BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tenant_id             BIGINT NOT NULL REFERENCES tenants(id),
    calendar_id           VARCHAR(255) NOT NULL DEFAULT 'primary',
    calendar_title        VARCHAR(255) NULL,
    push_meetings         BOOLEAN NOT NULL DEFAULT TRUE,   -- наши встречи → Google
    pull_events           BOOLEAN NOT NULL DEFAULT TRUE,   -- встречи Google → видны у нас
    sync_token            TEXT NULL,                       -- инкрементальная выборка (§73)
    last_pull_at          TIMESTAMPTZ NULL,
    last_error            TEXT NULL,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Наша встреча, положенная в Google Календарь конкретного человека. Уникальность —
-- защита от дублей при повторе запроса (§71).
CREATE TABLE google_calendar_events (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id          BIGINT NOT NULL REFERENCES tenants(id),
    user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_event_id  BIGINT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
    calendar_id        VARCHAR(255) NOT NULL,
    google_event_id    VARCHAR(255) NOT NULL,
    html_link          TEXT NULL,
    last_pushed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, calendar_event_id)
);
-- удаление встречи у нас каскадом стирает строку; убрать событие в Google нужно ДО этого
CREATE INDEX idx_google_calendar_events_event ON google_calendar_events (calendar_event_id);
