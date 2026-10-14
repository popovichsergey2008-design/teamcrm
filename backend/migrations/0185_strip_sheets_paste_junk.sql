-- #1559: служебный стиль Google Таблиц, вставленный вместе с текстом
-- («<!--td {border: 1px solid #cccccc;}br {mso-data-placement:same-cell;}-->»), —
-- вычищаем из уже сохранённого. Только этот узнаваемый образец: остальное не трогаем.
UPDATE tasks SET description = regexp_replace(description, '<!--td \{[^}]*\}br \{mso-data-placement:same-cell;\}-->', '', 'g')
 WHERE description LIKE '%mso-data-placement:same-cell%';
UPDATE task_comments SET body = regexp_replace(body, '<!--td \{[^}]*\}br \{mso-data-placement:same-cell;\}-->', '', 'g')
 WHERE body LIKE '%mso-data-placement:same-cell%';
UPDATE chat_messages SET body = regexp_replace(body, '<!--td \{[^}]*\}br \{mso-data-placement:same-cell;\}-->', '', 'g')
 WHERE body LIKE '%mso-data-placement:same-cell%';
