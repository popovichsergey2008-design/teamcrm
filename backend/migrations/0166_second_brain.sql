-- ТЗ-21, этап 4: «вторая память» компании.
--
-- В базе знаний были задачи, комментарии, регламенты, файлы и встречи целиком. Теперь
-- туда же ложатся переписка (только для участников чата), решения, новости, заметки
-- о клиентах и проекты, а встреча режется по репликам — с секундой, где это сказано.
-- Поиск — по смыслу И по словам: названия, номера, фамилии смысловой поиск теряет.

ALTER TABLE knowledge_chunks
    -- переписка: фрагмент видят только участники чата — и руководитель тоже не видит чужую личку
    ADD COLUMN IF NOT EXISTS chat_id    BIGINT NULL,
    -- только для сотрудников (заметки о клиентах, внешние чаты): клиенту не показываем
    ADD COLUMN IF NOT EXISTS staff_only BOOLEAN NOT NULL DEFAULT FALSE,
    -- куда вести из ответа: секунда записи, сообщение, задача, клиент
    ADD COLUMN IF NOT EXISTS anchor     JSONB NULL,
    -- когда это было и кто сказал — для фильтров «за период» и «кто»
    ADD COLUMN IF NOT EXISTS source_at  TIMESTAMPTZ NULL,
    ADD COLUMN IF NOT EXISTS author_id  BIGINT NULL,
    ADD COLUMN IF NOT EXISTS tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('russian'::regconfig, coalesce(title, '') || ' ' || content)) STORED;

CREATE INDEX IF NOT EXISTS idx_knowledge_tsv  ON knowledge_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS idx_knowledge_chat ON knowledge_chunks (chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_knowledge_at   ON knowledge_chunks (tenant_id, source_at);

-- «Решение изменили 02.09»: старое не стирается и не снимается, а ведёт на новое.
ALTER TABLE decisions
    ADD COLUMN IF NOT EXISTS superseded_by BIGINT NULL REFERENCES decisions(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ NULL;
