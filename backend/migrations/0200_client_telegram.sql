-- Итоги встречи клиенту в Telegram (#1525, фича 5 «ВАУ-секретаря»).
--
-- Клиент — не пользователь CRM: у него нет кода привязки из веб-CRM. Организатор
-- отправляет ему ссылку t.me/<бот>?start=<код>; клиент нажимает «Запустить» — бот
-- запоминает его чат за клиентом (и контактом) и сразу присылает итоги. В следующий
-- раз итоги уходят в этот чат одной кнопкой.
--
-- Код — случайный (128 бит), в базе только его SHA-256: утечка таблицы не даёт
-- рабочих ссылок. Код одноразовый и живёт 14 дней.

CREATE TABLE IF NOT EXISTS client_telegram_links (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id        BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id        BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id       BIGINT NULL REFERENCES client_contacts(id) ON DELETE SET NULL,
    telegram_chat_id VARCHAR(32) NOT NULL,
    telegram_name    VARCHAR(160) NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- клиент заблокировал бота (Telegram ответил 403) — больше туда не пишем
    revoked_at       TIMESTAMPTZ NULL,
    UNIQUE (tenant_id, client_id, telegram_chat_id)
);
CREATE INDEX IF NOT EXISTS idx_client_tg_links_client ON client_telegram_links (client_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_client_tg_links_chat ON client_telegram_links (telegram_chat_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS client_telegram_codes (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id    BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id    BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id   BIGINT NULL REFERENCES client_contacts(id) ON DELETE SET NULL,
    -- карточка «итоги клиенту», по которой выдан код: что доставить при запуске бота
    proposal_id  BIGINT NULL REFERENCES assistant_proposals(id) ON DELETE CASCADE,
    meeting_id   BIGINT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    created_by   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash    CHAR(64) NOT NULL UNIQUE,
    -- текст итогов на момент выдачи ссылки (организатор мог поправить его в окне)
    message      TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ NULL,
    used_chat_id VARCHAR(32) NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_tg_codes_proposal ON client_telegram_codes (proposal_id) WHERE used_at IS NULL;
