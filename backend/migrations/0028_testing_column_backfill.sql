-- Бэкфилл: добавить колонку «На тестировании» в СУЩЕСТВУЮЩИЕ проекты (перед «готовой» колонкой),
-- где её ещё нет. Идемпотентно (по имени). Новые проекты уже получают её в дефолтном наборе.
-- Позиции сдвигаются через большой оффсет, чтобы не нарушить UNIQUE(project_id, position).
DO $$
DECLARE
  proj RECORD;
  ins_pos INT;
BEGIN
  FOR proj IN
    SELECT p.id, p.tenant_id
      FROM projects p
     WHERE NOT EXISTS (
       SELECT 1 FROM board_columns c
        WHERE c.project_id = p.id AND lower(c.name) = 'на тестировании'
     )
  LOOP
    -- позиция «готовой» колонки (минимальная среди done-имён), иначе — в конец доски
    SELECT MIN(position) INTO ins_pos
      FROM board_columns
     WHERE project_id = proj.id
       AND lower(name) IN ('done','готово','выполнено','завершено','завершён','завершен','закрыто','сделано');

    IF ins_pos IS NULL THEN
      SELECT COALESCE(MAX(position), -1) + 1 INTO ins_pos FROM board_columns WHERE project_id = proj.id;
    ELSE
      -- освободить позицию ins_pos: сдвинуть её и последующие на +1 (через оффсет, чтобы не нарушить UNIQUE)
      UPDATE board_columns SET position = position + 100000 WHERE project_id = proj.id AND position >= ins_pos;
    END IF;

    INSERT INTO board_columns (tenant_id, project_id, name, position)
    VALUES (proj.tenant_id, proj.id, 'На тестировании', ins_pos);

    -- вернуть сдвинутые колонки на их место +1 (net: сдвиг на 1, освобождена позиция ins_pos)
    UPDATE board_columns SET position = position - 99999 WHERE project_id = proj.id AND position >= ins_pos + 100000;
  END LOOP;
END $$;
