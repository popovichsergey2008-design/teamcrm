-- #4892 ТЗ «Календарь»: что внедрить.

-- Личные настройки календаря: рабочие часы и обед человека (в его поясе), цель фокуса
-- на неделю, скрытые подсказки ассистента, подсказка встречи в чате, за сколько минут
-- присылать подготовку к встрече, прошёл ли человек первый вход.
CREATE TABLE IF NOT EXISTS calendar_user_prefs (
    user_id        BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tenant_id      BIGINT NOT NULL REFERENCES tenants(id),
    work_start     VARCHAR(5) NULL,
    work_end       VARCHAR(5) NULL,
    lunch_start    VARCHAR(5) NULL,
    lunch_end      VARCHAR(5) NULL,
    focus_goal_min INT NOT NULL DEFAULT 0,
    dismissed      TEXT[] NOT NULL DEFAULT '{}',
    chat_suggest   BOOLEAN NOT NULL DEFAULT TRUE,
    prep_min       INT NOT NULL DEFAULT 10,
    onboarded_at   TIMESTAMPTZ NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Как создана встреча: phrase | find_time | chat | agent | assistant — для метрик ТЗ
-- («доля встреч, созданных через „Найти время“, фразу или чат»).
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS created_via VARCHAR(16) NULL;
-- Подготовка к встрече ушла (за 10 минут) — на это начало.
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS prep_sent_for TIMESTAMPTZ NULL;
-- Причина отказа: «в это время у врача» — видна организатору в баннере переноса.
ALTER TABLE calendar_participants ADD COLUMN IF NOT EXISTS comment VARCHAR(300) NULL;

-- Повестку можно править и отправлять участникам по кнопке.
ALTER TABLE meeting_agendas ADD COLUMN IF NOT EXISTS edited_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE meeting_agendas ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ NULL;

-- Встреча из чата: QEVO AI предложил слоты, участники голосуют.
CREATE TABLE IF NOT EXISTS chat_meeting_proposals (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
    chat_id      BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id   BIGINT NULL REFERENCES chat_messages(id) ON DELETE SET NULL,
    source_message_id BIGINT NULL REFERENCES chat_messages(id) ON DELETE SET NULL,
    author_id    BIGINT NOT NULL REFERENCES users(id),
    topic        VARCHAR(255) NULL,
    minutes      INT NOT NULL DEFAULT 30,
    member_ids   BIGINT[] NOT NULL DEFAULT '{}',
    slots        JSONB NOT NULL DEFAULT '[]'::jsonb,
    votes        JSONB NOT NULL DEFAULT '{}'::jsonb,
    status       VARCHAR(16) NOT NULL DEFAULT 'open', -- open | scheduled | cancelled
    event_id     BIGINT NULL REFERENCES calendar_events(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_meeting_proposals_chat ON chat_meeting_proposals (chat_id, created_at DESC);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS proposal_id BIGINT NULL REFERENCES chat_meeting_proposals(id) ON DELETE SET NULL;

-- Журнал созвонов: и начатые сразу из чата попадают в календарь (п. 0).
CREATE TABLE IF NOT EXISTS call_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
    room_id         VARCHAR(64) NOT NULL,
    chat_id         BIGINT NULL REFERENCES chats(id) ON DELETE SET NULL,
    started_by      BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    participant_ids BIGINT[] NOT NULL DEFAULT '{}',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_call_log_tenant ON call_log (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_log_room ON call_log (room_id) WHERE ended_at IS NULL;

-- Яндекс Календарь по CalDAV (п. 1): логин и пароль приложения — зашифрованы.
CREATE TABLE IF NOT EXISTS calendar_caldav_accounts (
    user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
    provider      VARCHAR(16) NOT NULL DEFAULT 'yandex',
    login         VARCHAR(255) NOT NULL,
    password_enc  TEXT NOT NULL,
    calendar_url  TEXT NOT NULL,
    calendar_title VARCHAR(255) NULL,
    last_sync_at  TIMESTAMPTZ NULL,
    last_error    TEXT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Что QEVO положил во внешний календарь — чтобы при отключении убрать всё до последнего.
CREATE TABLE IF NOT EXISTS calendar_caldav_events (
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id   BIGINT NOT NULL,
    href       TEXT NOT NULL,
    starts_at  TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, event_id)
);
