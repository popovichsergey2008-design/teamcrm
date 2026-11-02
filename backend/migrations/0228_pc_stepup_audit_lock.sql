-- Консоли платформы (ТЗ консолей, §3 и §10; 02.11).
--
-- 1. Повторное подтверждение личности для чувствительных операций (ключи, выключатели
--    ИИ, цены, роли сотрудников, массовый сбой): код из приложения-аутентификатора, после
--    него 10 минут в этой сессии код не спрашивается.
-- 2. Журнал консолей не правится и не удаляется — ни консолью, ни обычным запросом:
--    запись можно только добавить. Чистка по сроку хранения — отдельной процедурой
--    владельца базы (триггер отключается явно, это видно в журнале изменений схемы).

ALTER TABLE pc_sessions ADD COLUMN stepup_until TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION pc_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pc_audit: журнал только дополняется';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pc_audit_no_update BEFORE UPDATE OR DELETE ON pc_audit
  FOR EACH ROW EXECUTE FUNCTION pc_audit_append_only();
