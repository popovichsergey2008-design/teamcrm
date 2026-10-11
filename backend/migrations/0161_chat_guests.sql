-- Внешние участники чата (#1539): кто вошёл по ссылке и кого из них убрали.
--
-- До сих пор гость существовал только подписью под своими сообщениями, и убрать его
-- было нельзя: гостевой токен жил своё (4 часа) даже после отзыва ссылки. Теперь каждый
-- вход по ссылке чата — строка здесь, а удалённый гость теряет доступ сразу.
--
-- gid — тот же id, что в гостевом токене. Для гостей, вошедших до этой таблицы, его
-- нет: таких убирают по имени (строка с gid NULL и removed_at).
CREATE TABLE IF NOT EXISTS chat_guests (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    chat_id     BIGINT      NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    gid         UUID        NULL,
    name        VARCHAR(60) NOT NULL,
    link_id     BIGINT      NULL REFERENCES meet_guest_links(id) ON DELETE SET NULL,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at  TIMESTAMPTZ NULL,
    removed_by  BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS chat_guests_chat_idx ON chat_guests (chat_id, joined_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS chat_guests_gid_uq ON chat_guests (gid) WHERE gid IS NOT NULL;
