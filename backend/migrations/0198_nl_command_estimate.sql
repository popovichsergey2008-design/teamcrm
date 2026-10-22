-- NL-команда, версия 4 (#4618): голосом заполняется вся форма «Новая задача», включая оценку.
--
-- Окно ручной постановки получило микрофон: человек наговаривает задачу, и поля
-- заполняются сами. В схеме ответа не было оценки трудозатрат — значит, модель её не
-- возвращала. Добавляем поле estimateHours: только если оценку назвали, иначе null
-- (сервер всё равно сначала ищет её правилами — модель любит «оценивать» сама).
--
-- Берём действующую глобальную версию и дописываем в неё одно правило и одно поле
-- схемы — остальной текст не трогаем. Клоны арендаторов (clone-on-write) не меняются.

WITH tpl AS (
    SELECT id FROM prompt_templates WHERE tenant_id IS NULL AND key = 'nl.command'
), cur AS (
    SELECT body, params FROM prompt_versions
     WHERE template_id = (SELECT id FROM tpl) AND status = 'active'
     ORDER BY version DESC LIMIT 1
), demoted AS (
    UPDATE prompt_versions SET status = 'deprecated'
     WHERE template_id = (SELECT id FROM tpl) AND status = 'active'
       AND EXISTS (SELECT 1 FROM cur WHERE body NOT LIKE '%estimateHours%')
    RETURNING 1
)
INSERT INTO prompt_versions (template_id, version, body, params, status, note)
SELECT
    (SELECT id FROM tpl),
    COALESCE((SELECT MAX(version) FROM prompt_versions WHERE template_id = (SELECT id FROM tpl)), 0) + 1,
    replace(
      replace(cur.body,
        '"requiresApproval":true,"checklist":[]',
        '"requiresApproval":true,"estimateHours":null,"checklist":[]'),
      'Верни СТРОГО JSON',
      'estimateHours — оценка трудозатрат в часах, ТОЛЬКО если человек её назвал («займёт 3 часа», «два дня работы» = 16); не назвал — null, сам не оценивай.

Верни СТРОГО JSON'),
    cur.params,
    'active',
    'Оценка трудозатрат (estimateHours), если её назвали — для голосового заполнения формы задачи'
FROM cur
WHERE cur.body NOT LIKE '%estimateHours%';
