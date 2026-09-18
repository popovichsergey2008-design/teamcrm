-- Этап 4 коммерческой архитектуры поддержки: созвон по просьбе и согласию.
--
-- До этой миграции трубка означала «звоню прямо сейчас»: комната поднималась мгновенно,
-- ссылка падала в разговор, и вторая сторона узнавала о созвоне по факту. Для
-- коммерческой поддержки это неверно с обеих сторон — клиент дёргает специалиста без
-- предупреждения, специалист зовёт клиента, который может быть на совещании или за рулём
-- (04_SUPPORT_HUDDLE §2).
--
-- Теперь это две отдельные вещи: ПРОСЬБА о созвоне и СОГЛАСИЕ на него. Комната
-- поднимается в момент согласия, а не в момент просьбы: нет согласия — нет и комнаты,
-- которую некому закрыть.

/*
  Просьба о созвоне.

  `requested_role` — кто просит: клиент («позвоните мне») или специалист («давайте
  созвонимся, так быстрее»). Формулировка на экране у второй стороны разная, и брать её
  из роли участника в момент показа — значит однажды перепутать.

  `status`: requested → accepted | declined | expired. Отказ здесь — обычное состояние,
  а не ошибка: «сейчас неудобно» должно быть таким же простым ответом, как «давайте».

  Комнату и гостевую ссылку записываем сюда же: по ним вторая сторона входит, и они
  появляются только вместе с согласием.
*/
CREATE TABLE support_call_requests (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    requested_by    BIGINT NOT NULL REFERENCES users(id),
    requested_role  VARCHAR(8) NOT NULL CHECK (requested_role IN ('user', 'agent')),
    status          VARCHAR(12) NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested', 'accepted', 'declined', 'expired')),
    room_id         VARCHAR(64) NULL,
    join_url        TEXT NULL,
    decided_by      BIGINT NULL REFERENCES users(id),
    decided_at      TIMESTAMPTZ NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Живую просьбу ищут при каждом открытии разговора обеими сторонами.
CREATE INDEX idx_call_requests_live
    ON support_call_requests (conversation_id, created_at DESC)
    WHERE status = 'requested';

/*
  Когда предупредили о записи.

  Запись допускается только после уведомления (04_SUPPORT_HUDDLE §10). Храним отметку, а
  не согласие галочкой: предупреждение уходит в сам разговор отдельным сообщением — его
  видно обеим сторонам и оно остаётся в переписке, в отличие от галочки, о которой через
  месяц никто не вспомнит.
*/
ALTER TABLE support_huddles ADD COLUMN recording_notified_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  RAISE NOTICE 'созвон поддержки: просьба и согласие разделены';
END $$;
