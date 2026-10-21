-- 21.10 (заказчик): задача на тестировании, проверке, согласовании или в «Готово» —
-- сдана, риска срыва у исполнителя нет. Прогноз пересчитывался только при назначении и
-- смене оценки, поэтому у сданных задач оставалась красная точка «риск срока».
UPDATE tasks
   SET risk_level = 'green', risk_pct = NULL, predicted_finish_at = NULL
 WHERE task_stage(column_id, approval_state, closed_at) <> 'work'
   AND risk_level IS DISTINCT FROM 'green';
