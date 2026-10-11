-- ТЗ-21, этапы 6–7: письмо клиенту после встречи и утренний бриф голосом.
--
-- followup_checked_at — встречу уже смотрели на «кому из клиентов написать итоги»:
-- навык не возвращается к ней второй раз. Старые встречи помечаем сразу — писать
-- клиентам по прошлогодним планёркам никто не просил.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS followup_checked_at TIMESTAMPTZ NULL;
UPDATE meetings SET followup_checked_at = now() WHERE followup_checked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_meetings_followup ON meetings (tenant_id, id) WHERE followup_checked_at IS NULL;
