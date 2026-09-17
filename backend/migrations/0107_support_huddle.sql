-- Созвон из поддержки и связь разговора со встречей (ТЗ-8, разд. 13, 14, 46).
--
-- Созвон у нас уже есть — со звуком, видео, демонстрацией экрана, записью,
-- расшифровкой и ИИ-разбором. Поддержке не нужен свой: нужен якорь, по которому
-- итог разговора вернётся туда, откуда звонили.
CREATE TABLE support_huddles (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    -- комната созвона (она же id встречи для разбора); встреча появится после записи
    room_id         VARCHAR(64) NOT NULL,
    meeting_id      BIGINT NULL REFERENCES meetings(id) ON DELETE SET NULL,
    started_by      BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ NULL
);
CREATE INDEX idx_support_huddles_conv ON support_huddles (conversation_id, started_at DESC);
CREATE INDEX idx_support_huddles_room ON support_huddles (room_id);
