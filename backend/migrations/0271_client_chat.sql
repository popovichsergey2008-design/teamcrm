-- #4902, п. 15: клиент в чате без регистрации (аналог Slack Connect, но без аккаунта у клиента).
--
-- 1. client_chat_links — постоянная ссылка на ОДИН внешний чат. В базе только хэш токена.
--    У ссылки своя переговорная (room_id): «Позвонить» с гостевой страницы ведёт в созвон
--    этого разговора через обычную гостевую ссылку созвона (meet_guest_links), которую мы
--    выпускаем по требованию и храним зашифрованной, чтобы не плодить новую на каждый звонок.
-- 2. client_chat_sessions — гость представился: по ключу сессии он читает и пишет только
--    этот чат. Ключ уходит гостю один раз, в базе — хэш. Отзыв ссылки гасит все её сессии.
-- 3. client_chat_tasks — задачи, которые сотрудник открыл клиенту: только их статусы гость
--    и видит. Ни номеров, ни исполнителей, ни проектов наружу не уходит.

CREATE TABLE IF NOT EXISTS client_chat_links (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id      BIGINT       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    chat_id        BIGINT       NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    token_hash     VARCHAR(64)  NOT NULL UNIQUE,
    label          VARCHAR(120) NULL,
    room_id        VARCHAR(64)  NOT NULL,
    meet_link_id   BIGINT       NULL REFERENCES meet_guest_links(id) ON DELETE SET NULL,
    meet_token_enc TEXT         NULL,
    created_by     BIGINT       NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ  NOT NULL,
    revoked_at     TIMESTAMPTZ  NULL,
    revoked_by     BIGINT       NULL REFERENCES users(id) ON DELETE SET NULL,
    uses           INT          NOT NULL DEFAULT 0,
    last_used_at   TIMESTAMPTZ  NULL
);
CREATE INDEX IF NOT EXISTS client_chat_links_chat_idx ON client_chat_links (tenant_id, chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS client_chat_sessions (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT       NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    link_id       BIGINT       NOT NULL REFERENCES client_chat_links(id) ON DELETE CASCADE,
    chat_id       BIGINT       NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    session_hash  VARCHAR(64)  NOT NULL UNIQUE,
    gid           UUID         NOT NULL,
    name          VARCHAR(60)  NOT NULL,
    email         VARCHAR(320) NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ  NULL,
    expires_at    TIMESTAMPTZ  NOT NULL,
    revoked_at    TIMESTAMPTZ  NULL
);
CREATE INDEX IF NOT EXISTS client_chat_sessions_link_idx ON client_chat_sessions (link_id);

CREATE TABLE IF NOT EXISTS client_chat_tasks (
    tenant_id  BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    chat_id    BIGINT      NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    task_id    BIGINT      NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    opened_by  BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    opened_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, task_id)
);
CREATE INDEX IF NOT EXISTS client_chat_tasks_tenant_idx ON client_chat_tasks (tenant_id, chat_id);
