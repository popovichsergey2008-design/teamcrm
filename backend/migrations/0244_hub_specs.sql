-- #4801: ТЗ, которые библиотекарь Инфоцентра взял из задач (ссылка на Google-документ в
-- описании или документ во вложении), — раздел «ТЗ и спецификации», а не «Документы».
-- Только то, что положил сам ИИ: разложенное людьми не трогаем.
UPDATE project_hub_items
   SET category = 'spec'
 WHERE section = 'knowledge' AND category = 'doc' AND source = 'ai' AND removed_at IS NULL
   AND origin->>'type' = 'task'
   AND (url LIKE 'https://docs.google.com/document/%' OR url LIKE 'https://docs.google.com/spreadsheets/%'
        OR url LIKE 'https://docs.google.com/presentation/%' OR (kind = 'file' AND url IS NULL));
