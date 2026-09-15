-- Ветки и закреплённые сообщения в обсуждении задачи (ТЗ-7, разд. 7 и 20).
--
-- Раньше ветку сознательно не заводили: разговор по задаче линейный, и людям нужна
-- была ссылка на цитату, а не структура. Практика показала другое — в живой задаче
-- спор о сроке и спор о тексте идут одновременно, и в общей ленте они перемешаны.
-- Ветка отделяет один разговор от другого, не заводя второго чата.
--
-- Корень ветки — ВСЕГДА сообщение верхнего уровня: ответ на ответ уходит в ту же
-- ветку, что и родитель. Дерево в переписке никто не читает, а поддерживать его
-- пришлось бы в каждом запросе.
ALTER TABLE task_comments
    ADD COLUMN thread_root_id BIGINT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
    -- ответ, который важен всем: показывается и в ветке, и в общей ленте
    ADD COLUMN also_in_channel BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN pinned_at TIMESTAMPTZ NULL,
    ADD COLUMN pinned_by BIGINT NULL REFERENCES users(id);

-- Лента задачи всегда спрашивает «только верхний уровень»: частичный индекс дешевле
-- полного и ровно под этот вопрос.
CREATE INDEX idx_task_comments_root
    ON task_comments (tenant_id, task_id, created_at)
    WHERE thread_root_id IS NULL;

-- Ответы ветки читаются пачкой по корню.
CREATE INDEX idx_task_comments_thread ON task_comments (thread_root_id, created_at)
    WHERE thread_root_id IS NOT NULL;

-- Закреплённых в задаче единицы: индекс только по ним.
CREATE INDEX idx_task_comments_pinned ON task_comments (tenant_id, task_id, pinned_at DESC)
    WHERE pinned_at IS NOT NULL;
