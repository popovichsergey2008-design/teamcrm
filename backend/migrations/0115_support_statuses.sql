-- Этап 5 коммерческой архитектуры поддержки: статусы, лента событий и внутренние заметки.
--
-- Статус обращения должен отвечать на вопрос «что с ним сейчас» без чтения переписки. До
-- этой миграции он отвечал плохо: работа инженера была неотличима от работы дежурного
-- («в работе»), а ожидание ответа клиента — от ожидания подтверждения решения.

/*
  Недостающие состояния (06_STATE_MACHINE §1).

  `engineer_escalated` — позвали инженера, ждём его;
  `fix_in_progress`    — чиним: заведена задача, идёт исправление;
  `waiting_reply`      — специалист задал вопрос и ждёт ответа человека.

  Последнее — не то же самое, что `waiting_user` («проверьте, решено?»): в одном случае
  мы ждём сведений, в другом — подтверждения, что всё починилось. Смешивать их значит
  потерять разницу между «человек не ответил» и «человек не проверил».

  Проверку значений в базе не ставим: статусы меняются кодом через таблицу переходов
  (support-status.ts), и второй список тех же значений в SQL разошёлся бы с ней при
  первом же добавлении.
*/
COMMENT ON COLUMN support_conversations.status IS
  'new | ai | waiting_agent | in_progress | engineer_escalated | fix_in_progress | waiting_reply | waiting_user | resolved | closed';

/*
  Внутренние заметки специалиста.

  Их не видит клиент — никогда и никаким путём. Поэтому отдельная таблица, а не вид
  сообщения: сообщение с флагом «внутреннее» однажды уедет клиенту из-за забытого
  условия в выборке, и это будет очень плохой день.

  Отдаются только своей ручкой, за проверкой прав на разговор.
*/
CREATE TABLE support_internal_notes (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    author_id       BIGINT NOT NULL REFERENCES users(id),
    body            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_internal_notes_conv ON support_internal_notes (conversation_id, created_at);

DO $$
BEGIN
  RAISE NOTICE 'статусы дополнены, внутренние заметки заведены';
END $$;
