-- ТЗ-30, правка 12.10: тип этапа по названию колонки — не только точным списком.
--
-- Жалоба заказчика: задачи «на тестировании» в отчёте всё равно числились просроченными.
-- Колонки называют по-разному («На тесте», «Тестируется», «QA / тест», «Проверка заказчиком»),
-- и точный список их не узнавал — колонка считалась «работой». Теперь сначала точные
-- имена, затем — по частям слова. Колонки с типом, выставленным руками, не трогаем.

CREATE OR REPLACE FUNCTION column_stage_by_name(n TEXT) RETURNS VARCHAR AS $$
  SELECT CASE
    -- точные имена — как раньше
    WHEN lower(btrim(coalesce(n, ''))) IN ('done', 'готово', 'выполнено', 'завершено', 'завершён', 'завершен', 'закрыто', 'сделано') THEN 'done'
    WHEN lower(btrim(coalesce(n, ''))) IN ('на тестировании', 'тестирование', 'testing', 'qa', 'тест', 'test') THEN 'testing'
    WHEN lower(btrim(coalesce(n, ''))) IN ('на проверке', 'проверка', 'ревью', 'review', 'in review', 'code review', 'на ревью') THEN 'review'
    WHEN lower(btrim(coalesce(n, ''))) IN ('на согласовании', 'согласование', 'на приёмке', 'на приемке', 'приёмка', 'приемка', 'approval', 'waiting approval') THEN 'approval'
    WHEN lower(btrim(coalesce(n, ''))) IN ('ждём клиента', 'ждем клиента', 'у клиента', 'ожидает клиента', 'waiting client', 'waiting for client', 'на стороне клиента') THEN 'waiting_external'
    -- по частям слова: сначала «ждём клиента», потом приёмка/согласование, проверка, тест
    WHEN lower(n) ~ '(жд[её]м|ожида).*(клиент|заказчик)|(клиент|заказчик).*(жд[её]т|ожида)|waiting.*(client|customer)' THEN 'waiting_external'
    WHEN lower(n) ~ '(соглас|при[её]мк|утвержд|approv|accept)' THEN 'approval'
    WHEN lower(n) ~ '(тест|test|qa\M|\mqa|qc\M)' THEN 'testing'
    WHEN lower(n) ~ '(провер|ревью|review|ревю)' THEN 'review'
    WHEN lower(n) ~ '(^|\s)(готов|done|выполнен|завершен|завершён|закрыт|сделан)' AND lower(n) !~ '(к работе|к выполн|to do)' THEN 'done'
    ELSE 'work'
  END
$$ LANGUAGE sql IMMUTABLE;

-- пересчитать автоматические типы; триггер колонок здесь не нужен — ставим сами
UPDATE board_columns SET stage_type = column_stage_by_name(name) WHERE NOT stage_type_manual AND stage_type IS DISTINCT FROM column_stage_by_name(name);

/*
  Задачам, которые сейчас стоят в колонках, ставших «проверкой», — время сдачи из
  журнала переносов (как в 0180), иначе — с последней правки.
*/
WITH sub AS (
  SELECT a.task_id, min(a.created_at) AS first_at, max(a.created_at) AS last_at
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

UPDATE tasks t SET submitted_at = coalesce(t.submitted_at, t.updated_at), first_submitted_at = coalesce(t.first_submitted_at, t.updated_at)
 WHERE t.closed_at IS NULL AND t.submitted_at IS NULL
   AND task_stage(t.column_id, t.approval_state, t.closed_at) IN ('testing', 'review', 'approval', 'waiting_external');
