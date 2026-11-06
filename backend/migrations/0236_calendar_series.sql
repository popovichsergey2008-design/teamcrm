-- #4787 (ТЗ календаря, п. 17): повторяющиеся встречи.
--
-- Каждый повтор — настоящее событие (со своими участниками, напоминаниями, ссылкой на
-- созвон): занятость, запись по ссылке и напоминания работают без особых случаев.
-- series_id связывает повторы, series_rule — как повторяется («каждую неделю»), чтобы
-- при правке спросить: только эту встречу, эту и последующие или всю серию.
ALTER TABLE calendar_events
    ADD COLUMN IF NOT EXISTS series_id   UUID NULL,
    ADD COLUMN IF NOT EXISTS series_rule VARCHAR(16) NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_events_series ON calendar_events (tenant_id, series_id, starts_at) WHERE series_id IS NOT NULL;
