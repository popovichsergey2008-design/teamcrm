-- Гостевая ссылка со временем встречи.
--
-- Ссылку внешнему гостю отправляют заранее («завтра в 9»), а знала она только срок
-- действия. Гость, открывший её накануне, видел «войдите и подождите» и ждал до утра,
-- а команда о нём не знала: стук слышат только те, кто уже сидит в комнате.
--
-- starts_at — когда встреча: до неё гостю показываем время и отсчёт, войти можно
-- незадолго до начала. event_id — событие календаря, из которого выдана ссылка:
-- комната у них общая, и «Войти в созвон» в событии ведёт туда же, куда придёт гость.
-- reminded_at — напоминание автору перед началом уже ушло (раз на ссылку).
ALTER TABLE meet_guest_links
    ADD COLUMN starts_at   TIMESTAMPTZ NULL,
    ADD COLUMN event_id    BIGINT NULL REFERENCES calendar_events(id) ON DELETE SET NULL,
    ADD COLUMN reminded_at TIMESTAMPTZ NULL;

CREATE INDEX idx_meet_guest_links_upcoming ON meet_guest_links (starts_at)
    WHERE starts_at IS NOT NULL AND reminded_at IS NULL AND revoked_at IS NULL;
