-- Продукт переименован: ANTHILL → QEVO (решение заказчика 07.10.2026, новый логотип).
--
-- Справочник по системе лежит в базе знаний КАЖДОЙ организации отдельными регламентами.
-- Константа PREFIX в коде уже новая; без этой миграции загрузчик завёл бы рядом такие же
-- документы с новым именем — два справочника в одной базе знаний. Переименовываем, а не
-- удаляем: у документов есть история правок и ссылки (так же было в 0110_brand_anthill).

UPDATE regulations
   SET title = replace(title, 'Справочник ANTHILL · ', 'Справочник QEVO · '),
       updated_at = now()
 WHERE title LIKE 'Справочник ANTHILL · %';

-- Куски поискового индекса держат снимок текста ВМЕСТЕ с заголовком: без удаления поиск
-- ещё долго отвечал бы «Справочник ANTHILL · …». Сервис справочника при ближайшей сверке
-- увидит разделы без кусков и переиндексирует их.
DELETE FROM knowledge_chunks
 WHERE source_type = 'regulation'
   AND source_id IN (SELECT id FROM regulations WHERE title LIKE 'Справочник QEVO · %');

DO $$
DECLARE renamed INT;
BEGIN
  SELECT count(*) INTO renamed FROM regulations WHERE title LIKE 'Справочник QEVO · %';
  RAISE NOTICE 'справочник переименован в QEVO: разделов %', renamed;
END $$;
