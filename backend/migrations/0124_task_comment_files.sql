-- Несколько файлов в одном комментарии задачи.
--
-- В переписке это уже работает (миграция 0086): человек прикладывает три снимка и
-- получает ОДНО сообщение. В обсуждении задачи так было нельзя — у комментария одно
-- поле `file_id`, и три снимка превращались в три комментария подряд. Заказчик просит
-- одинакового поведения: «как в чатах».
--
-- Старое поле НЕ убираем: на нём держатся выборки ленты задачи, поиск по вложениям,
-- перенос комментариев из YouGile и Битрикса. Оно продолжает хранить ПЕРВЫЙ файл —
-- старый код работает как прежде, новый берёт полный список отсюда.
CREATE TABLE task_comment_files (
    comment_id BIGINT NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
    file_id    BIGINT NOT NULL REFERENCES files(id),
    tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
    -- Порядок показа: снимки прикладывают в осмысленной последовательности.
    position   INT NOT NULL DEFAULT 0,
    PRIMARY KEY (comment_id, file_id)
);

CREATE INDEX idx_task_comment_files ON task_comment_files (comment_id, position);

-- Уже существующие комментарии с файлом переносим в новую таблицу: иначе лента
-- показывала бы старые вложения по одному правилу, а новые — по другому.
INSERT INTO task_comment_files (comment_id, file_id, tenant_id, position)
SELECT c.id, c.file_id, c.tenant_id, 0 FROM task_comments c WHERE c.file_id IS NOT NULL
ON CONFLICT DO NOTHING;
