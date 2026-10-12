-- ТЗ-30: просрочка — по фактической ответственности, а не по фамилии исполнителя.
--
-- 1. У колонки появляется тип этапа: работа / проверка / согласование / ждём клиента /
--    готово. Ставится по названию (тем же набором, что раньше жил строками в коде) —
--    при создании, переименовании и импорте; можно поменять руками (stage_type_manual).
-- 2. На задаче — когда сдал на проверку, когда вернули и до какого срока доработать.
--    Ставятся триггером при смене колонки или отметки «ждёт приёмки», поэтому не
--    зависят от того, какой код двигает задачу (доска, импорт, разбор, приёмка).

CREATE OR REPLACE FUNCTION column_stage_by_name(n TEXT) RETURNS VARCHAR AS $$
  SELECT CASE
    WHEN lower(btrim(coalesce(n, ''))) IN ('done', 'готово', 'выполнено', 'завершено', 'завершён', 'завершен', 'закрыто', 'сделано') THEN 'done'
    WHEN lower(btrim(coalesce(n, ''))) IN ('на тестировании', 'тестирование', 'testing', 'qa', 'тест', 'test') THEN 'testing'
    WHEN lower(btrim(coalesce(n, ''))) IN ('на проверке', 'проверка', 'ревью', 'review', 'in review', 'code review', 'на ревью') THEN 'review'
    WHEN lower(btrim(coalesce(n, ''))) IN ('на согласовании', 'согласование', 'на приёмке', 'на приемке', 'приёмка', 'приемка', 'approval', 'waiting approval') THEN 'approval'
    WHEN lower(btrim(coalesce(n, ''))) IN ('ждём клиента', 'ждем клиента', 'у клиента', 'ожидает клиента', 'waiting client', 'waiting for client', 'на стороне клиента') THEN 'waiting_external'
    ELSE 'work'
  END
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE board_columns ADD COLUMN IF NOT EXISTS stage_type VARCHAR(16) NOT NULL DEFAULT 'work';
ALTER TABLE board_columns ADD COLUMN IF NOT EXISTS stage_type_manual BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE board_columns SET stage_type = column_stage_by_name(name) WHERE NOT stage_type_manual;

CREATE OR REPLACE FUNCTION board_columns_stage_auto() RETURNS trigger AS $$
BEGIN
  IF NOT NEW.stage_type_manual THEN
    NEW.stage_type := column_stage_by_name(NEW.name);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_board_columns_stage ON board_columns;
CREATE TRIGGER trg_board_columns_stage BEFORE INSERT OR UPDATE OF name, stage_type_manual ON board_columns
  FOR EACH ROW EXECUTE FUNCTION board_columns_stage_auto();

-- Окно доработки после возврата (решение 12.10: 24 ч, владелец меняет)
ALTER TABLE org_work_settings ADD COLUMN IF NOT EXISTS fix_window_hours INT NOT NULL DEFAULT 24;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS first_submitted_at TIMESTAMPTZ NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS fix_deadline_at TIMESTAMPTZ NULL;

/*
  Этап задачи: закрыта — готово; ждёт приёмки постановщика — согласование (она лежит
  в «Готово», но не закрыта); иначе — тип её колонки.
*/
CREATE OR REPLACE FUNCTION task_stage(p_column_id BIGINT, p_approval VARCHAR, p_closed TIMESTAMPTZ) RETURNS VARCHAR AS $$
  SELECT CASE
    WHEN p_closed IS NOT NULL THEN 'done'
    WHEN coalesce(p_approval, 'none') = 'pending' THEN 'approval'
    ELSE coalesce((SELECT stage_type FROM board_columns WHERE id = p_column_id), 'work')
  END
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION tasks_responsibility_marks() RETURNS trigger AS $$
DECLARE
  old_stage VARCHAR;
  new_stage VARCHAR;
  win INT;
BEGIN
  -- новый срок руками отменяет окно доработки: решение постановщика важнее правила
  IF TG_OP = 'UPDATE' AND NEW.deadline_at IS DISTINCT FROM OLD.deadline_at THEN
    NEW.fix_deadline_at := NULL;
  END IF;
  new_stage := task_stage(NEW.column_id, NEW.approval_state, NEW.closed_at);
  IF TG_OP = 'INSERT' THEN
    old_stage := 'work';
  ELSE
    old_stage := task_stage(OLD.column_id, OLD.approval_state, OLD.closed_at);
  END IF;
  IF new_stage IN ('testing', 'review', 'approval', 'waiting_external') AND old_stage NOT IN ('testing', 'review', 'approval', 'waiting_external') THEN
    -- сдал: ответственность исполнителя остановлена (п. 7)
    NEW.submitted_at := now();
    NEW.first_submitted_at := coalesce(NEW.first_submitted_at, now());
  ELSIF new_stage = 'work' AND old_stage IN ('testing', 'review', 'approval', 'waiting_external') THEN
    -- вернули на доработку: ответственность снова у исполнителя (п. 11–12)
    NEW.returned_at := now();
    SELECT coalesce(max(fix_window_hours), 24) INTO win FROM org_work_settings WHERE tenant_id = NEW.tenant_id;
    IF NEW.deadline_at IS NOT NULL AND NEW.deadline_at < now() THEN
      NEW.fix_deadline_at := now() + make_interval(hours => coalesce(win, 24));
    ELSE
      NEW.fix_deadline_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tasks_responsibility ON tasks;
CREATE TRIGGER trg_tasks_responsibility BEFORE INSERT OR UPDATE OF column_id, approval_state, closed_at, deadline_at ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_responsibility_marks();

/*
  История (решение 12.10): время сдачи — из журнала переносов. Открытые задачи, что
  сейчас на проверке, и закрытые за 90 дней: последняя и первая сдача.
*/
WITH sub AS (
  SELECT a.task_id,
         min(a.created_at) AS first_at,
         max(a.created_at) AS last_at
    FROM task_activity a
   WHERE (a.kind = 'approval_requested'
          OR (a.kind = 'moved' AND column_stage_by_name(a.detail->>'to') IN ('testing', 'review', 'approval', 'waiting_external')))
     AND a.created_at > now() - interval '120 days'
   GROUP BY a.task_id
)
UPDATE tasks t
   SET first_submitted_at = coalesce(t.first_submitted_at, sub.first_at),
       submitted_at = coalesce(t.submitted_at, sub.last_at)
  FROM sub
 WHERE sub.task_id = t.id
   AND (t.closed_at IS NULL OR t.closed_at > now() - interval '90 days');

-- открытые на проверке без следа в журнале — со времени последней правки
UPDATE tasks t SET submitted_at = coalesce(t.submitted_at, t.updated_at), first_submitted_at = coalesce(t.first_submitted_at, t.updated_at)
 WHERE t.closed_at IS NULL AND t.submitted_at IS NULL
   AND task_stage(t.column_id, t.approval_state, t.closed_at) IN ('testing', 'review', 'approval', 'waiting_external');

CREATE INDEX IF NOT EXISTS idx_board_columns_stage ON board_columns (project_id, stage_type);
