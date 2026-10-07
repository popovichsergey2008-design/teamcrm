-- ТЗ-18, этап 3: что секретарь уже прислал по конкретному поводу.
--
-- Справка перед встречей приходит один раз на встречу и человека — даже если в окне
-- отправки проходят два экземпляра сервера (синий и зелёный при выкладке) или
-- планировщик заходит дважды. Перенесли встречу — новый срок, новая справка (ref
-- включает время начала).

CREATE TABLE secretary_sent (
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind      VARCHAR(24) NOT NULL,          -- meeting_brief
    ref       VARCHAR(64) NOT NULL,          -- «событие:начало»
    sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, kind, ref)
);
CREATE INDEX idx_secretary_sent_at ON secretary_sent (sent_at);
