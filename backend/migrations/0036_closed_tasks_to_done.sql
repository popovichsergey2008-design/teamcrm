-- Завершённые задачи — в колонку «Готово».
--
-- В YouGile «завершено» это флажок на задаче, не связанный с колонкой: задача
-- может быть закрыта и при этом лежать в «Паузе». Импорт переносил её как есть,
-- и на доске копились карточки с отметкой «завершена» в рабочих колонках.
-- Дальше такие задачи раскладывает сам импорт; здесь разбираем накопленное.
--
-- Проекты без колонки «Готово» не трогаем: переносить некуда, а выдумывать
-- колонку на чужой доске нельзя.

WITH done_col AS (
    SELECT id, project_id, tenant_id, name,
           row_number() OVER (PARTITION BY project_id ORDER BY position, id) AS rn
      FROM board_columns
     WHERE lower(btrim(name)) IN
           ('done', 'готово', 'выполнено', 'завершено', 'завершён', 'завершен', 'закрыто', 'сделано')
), moving AS (
    SELECT t.id,
           d.id   AS col_id,
           d.name AS col_name,
           row_number() OVER (PARTITION BY d.id ORDER BY t.closed_at, t.id) AS rn
      FROM tasks t
      JOIN done_col d ON d.project_id = t.project_id AND d.tenant_id = t.tenant_id AND d.rn = 1
     WHERE t.closed_at IS NOT NULL
       AND t.column_id <> d.id
), tail AS (
    -- хвост целевой колонки: складываем перенесённые за уже лежащими там
    SELECT column_id, COALESCE(MAX(position), -1) + 1 AS start
      FROM tasks GROUP BY column_id
)
UPDATE tasks t
   SET column_id  = m.col_id,
       status     = m.col_name,
       position   = COALESCE(tail.start, 0) + m.rn - 1,
       updated_at = now()
  FROM moving m
  LEFT JOIN tail ON tail.column_id = m.col_id
 WHERE t.id = m.id;
