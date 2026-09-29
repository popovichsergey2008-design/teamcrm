-- ТЗ-12, этап 5: журнал решений, статусы и блокеры из переписки.
--
-- Решения до сих пор жили только внутри сводки встречи (meeting_summaries.decisions) и
-- нигде больше: «что мы решили по форме?» приходилось искать по протоколам. Журнал —
-- одно место для решений и со встреч, и из переписки (ТЗ разд. 24).

CREATE TABLE IF NOT EXISTS decisions (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         BIGINT      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id        BIGINT      NULL REFERENCES projects(id) ON DELETE SET NULL,
    -- Откуда решение: из переписки или со встречи. Ровно одно из двух.
    chat_id           BIGINT      NULL REFERENCES chats(id) ON DELETE CASCADE,
    meeting_id        BIGINT      NULL REFERENCES meetings(id) ON DELETE CASCADE,
    -- Наблюдение разбора, из которого решение выросло: по нему видны все сообщения.
    action_id         BIGINT      NULL REFERENCES chat_extracted_actions(id) ON DELETE SET NULL,
    -- Сообщение, где решение прозвучало: из журнала одним нажатием в разговор.
    source_message_id BIGINT      NULL REFERENCES chat_messages(id) ON DELETE SET NULL,
    text              TEXT        NOT NULL,
    details           TEXT        NOT NULL DEFAULT '',
    -- Кто решал: авторы сообщений-источников. Массивом — это подпись, а не связь.
    participants      BIGINT[]    NOT NULL DEFAULT '{}',
    decided_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Кто записал: человек, нажавший «в журнал», или пусто — записал агент сам.
    created_by        BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    -- Решение, записанное по ошибке или отменённое позже, не стирается, а снимается:
    -- «мы это решали и передумали» — тоже история.
    revoked_at        TIMESTAMPTZ NULL,
    revoked_by        BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT decisions_one_origin CHECK ((chat_id IS NULL) <> (meeting_id IS NULL))
);
CREATE INDEX IF NOT EXISTS decisions_project_idx ON decisions (tenant_id, project_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS decisions_chat_idx    ON decisions (chat_id, decided_at DESC) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS decisions_meeting_idx ON decisions (meeting_id) WHERE meeting_id IS NOT NULL;

-- Решения уже разобранных встреч — в журнал. Формат в сводке — массив строк; всё
-- другое (старые или битые записи) пропускаем, а не пишем в журнал JSON.
INSERT INTO decisions (tenant_id, project_id, meeting_id, text, decided_at)
SELECT m.tenant_id, m.project_id, m.id, btrim(d.value #>> '{}'), COALESCE(m.happened_at, m.created_at)
  FROM meeting_summaries s
  JOIN meetings m ON m.id = s.meeting_id
 CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(s.decisions) = 'array' THEN s.decisions ELSE '[]'::jsonb END) AS d(value)
 WHERE jsonb_typeof(d.value) = 'string'
   AND btrim(d.value #>> '{}') <> ''
   AND NOT EXISTS (SELECT 1 FROM decisions x WHERE x.meeting_id = m.id);

-- К какой задаче относится статус или блокер из переписки, и насколько это твёрдо:
-- 1 — задачу назвали или переслали, 0.8 — автор сообщения её исполнитель или постановщик.
ALTER TABLE chat_extracted_actions
    ADD COLUMN IF NOT EXISTS task_id BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS task_confidence NUMERIC(4,3) NOT NULL DEFAULT 0;
