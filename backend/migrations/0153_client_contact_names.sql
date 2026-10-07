-- ТЗ-17, починка переноса из 0152.
--
-- Старое поле clients.contact — свободный текст, и часто в нём лежал просто телефон
-- или почта. 0152 сделал его ИМЕНЕМ контактного лица — и номер стал виден в списке
-- клиентов без маски (имя не маскируется). Здесь такие «имена» переезжают туда, где
-- им место (телефон / почта — под маску), а имя становится «Основной контакт».

-- телефон в имени: 7+ цифр и ничего, кроме цифр, пробелов и знаков номера
UPDATE client_contacts
   SET phone = COALESCE(phone, first_name),
       phone_norm = COALESCE(phone_norm, NULLIF(regexp_replace(first_name, '[^0-9+]', '', 'g'), '')),
       first_name = 'Основной контакт',
       updated_at = now()
 WHERE first_name ~ '^[0-9+()\s.\-]+$'
   AND length(regexp_replace(first_name, '[^0-9]', '', 'g')) >= 7;

-- почта в имени
UPDATE client_contacts
   SET email = COALESCE(email, trim(first_name)),
       email_norm = COALESCE(email_norm, lower(trim(first_name))),
       first_name = 'Основной контакт',
       updated_at = now()
 WHERE first_name ~ '^\s*[^@\s]+@[^@\s]+\.[^@\s]+\s*$';

-- текст с номером внутри («Иван +7 999…»): номер — в телефон, имя — то, что до цифр
UPDATE client_contacts
   SET phone = COALESCE(phone, trim(substring(first_name from '[+0-9][0-9()\s.\-]{6,}'))),
       phone_norm = COALESCE(phone_norm, NULLIF(regexp_replace(substring(first_name from '[+0-9][0-9()\s.\-]{6,}'), '[^0-9+]', '', 'g'), '')),
       first_name = COALESCE(NULLIF(trim(regexp_replace(first_name, '[+0-9][0-9()\s.\-]{6,}', '', 'g')), ''), 'Основной контакт'),
       updated_at = now()
 WHERE first_name ~ '[+0-9][0-9()\s.\-]{6,}'
   AND length(regexp_replace(first_name, '[^0-9]', '', 'g')) >= 7;
