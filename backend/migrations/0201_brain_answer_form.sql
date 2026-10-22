-- «Второй мозг», версия 2 (#1525, фича 3): ответ формой документа.
--
-- Командная строка (Ctrl+K) отвечает на вопрос сама: «14 августа на 12-й минуте созвона
-- с Константином решено: заложить комиссию 2.5 процента в договор. Вот ссылка на созвон
-- с воспроизведением с 12:15». Контекст теперь несёт у фрагмента созвона дату, минуту
-- записи, участника и готовую «Подпись для ответа» — модель должна начать с неё дословно.
-- Ссылку на запись добавляет сервер (живую, с ?t=секунда), модель её не пишет.
--
-- Берём действующую глобальную версию и дописываем одно правило — остальной текст не
-- трогаем. Клоны арендаторов (clone-on-write) не меняются. Тот же текст — фолбэк в коде
-- (brain.service.ts, ANSWER_FORM_RULE). Повторный запуск ничего не делает.

WITH tpl AS (
    SELECT id FROM prompt_templates WHERE tenant_id IS NULL AND key = 'brain.system'
), cur AS (
    SELECT body, params FROM prompt_versions
     WHERE template_id = (SELECT id FROM tpl) AND status = 'active'
     ORDER BY version DESC LIMIT 1
), demoted AS (
    UPDATE prompt_versions SET status = 'deprecated'
     WHERE template_id = (SELECT id FROM tpl) AND status = 'active'
       AND EXISTS (SELECT 1 FROM cur WHERE body NOT LIKE '%Подпись для ответа%')
    RETURNING 1
)
INSERT INTO prompt_versions (template_id, version, body, params, status, note)
SELECT
    (SELECT id FROM tpl),
    COALESCE((SELECT MAX(version) FROM prompt_versions WHERE template_id = (SELECT id FROM tpl)), 0) + 1,
    cur.body || ' ' || $rule$Если ответ найден во фрагменте созвона, у которого в контексте есть «Подпись для ответа», ответь одной-двумя фразами в форме документа: начни ДОСЛОВНО с этой подписи и продолжи сутью решения, например: «14 августа на 12-й минуте созвона с Константином решено: заложить комиссию 2.5 процента в договор. [1]». Ссылку на запись не пиши — её добавит система. Пошаговый ответ — только для вопросов «как сделать».$rule$,
    cur.params,
    'active',
    'Ответ формой документа: дата, минута и участник созвона, ссылка на запись — от системы (#1525)'
FROM cur
WHERE cur.body NOT LIKE '%Подпись для ответа%';
