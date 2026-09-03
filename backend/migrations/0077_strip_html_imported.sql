-- Чистка разметки в уже импортированных задачах.
--
-- YouGile отдаёт описания и комментарии в HTML, и до сегодняшнего дня они складывались
-- как есть: в карточке вместо текста читалось «<p>Сделать <strong>до пятницы</strong></p>».
-- Импорт теперь чистит разметку на входе (см. integrations/html-text.ts), но всё уже
-- завезённое надо привести в порядок здесь — переимпорт для этого гонять незачем.
--
-- Трогаем ТОЛЬКО импортированные записи и только те, где разметка действительно есть:
-- у текста, написанного человеком в CRM, «5 < 7» не должно ничего лишиться.

-- Порядок важен: сначала блочные теги в переводы строк, потом снятие остальных тегов,
-- потом сущности. Иначе «&lt;p&gt;» из безобидного текста превратится в тег и исчезнет.
CREATE OR REPLACE FUNCTION strip_html_text(src TEXT) RETURNS TEXT AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(
        replace(replace(replace(replace(replace(replace(replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(src, '<(script|style)[^>]*>.*?</\1>', '', 'gis'),
              '<li[^>]*>', E'\n• ', 'gi'),
            '<br\s*/?>|</(p|div|tr|h[1-6]|blockquote|pre)>', E'\n', 'gi'),
          '&nbsp;', ' '), '&amp;', '&'), '&lt;', '<'), '&gt;', '>'),
          '&quot;', '"'), '&laquo;', '«'), '&raquo;', '»'),
        '<[^>]+>', '', 'g'),
      E'\n{3,}', E'\n\n', 'g')
  );
$$ LANGUAGE SQL IMMUTABLE;

-- Описания импортированных задач.
UPDATE tasks t
   SET description = strip_html_text(t.description)
 WHERE t.description ~* '<[a-z/!][^>]*>'
   AND EXISTS (
     SELECT 1 FROM external_refs r
      WHERE r.tenant_id = t.tenant_id AND r.entity_type = 'task' AND r.local_id = t.id
   );

-- Комментарии импортированных задач.
UPDATE task_comments c
   SET body = strip_html_text(c.body)
 WHERE c.body ~* '<[a-z/!][^>]*>'
   AND EXISTS (
     SELECT 1 FROM external_refs r
      WHERE r.tenant_id = c.tenant_id AND r.entity_type = 'task' AND r.local_id = c.task_id
   );

-- Функция была нужна только для этой разовой чистки: дальше разметку снимает импорт.
DROP FUNCTION strip_html_text(TEXT);
