-- ТЗ-14: встреча = событие календаря с флагом «Созвон», у неё постоянная ссылка.
--
-- Ссылка на встречу — постоянный вход во «встречу», а не в живую комнату созвона: она
-- есть сразу при планировании, не меняется при переносе, открывается всегда и показывает
-- состояние («скоро», «идёт», «закончилась», «отменена»).
--
-- Сама ссылка — строка meet_guest_links вида 'meeting' (одна на событие) с коротким
-- public_id: так вся отлаженная механика гостевых ссылок (зал ожидания, ранний вход,
-- зов организатора, перенос времени, отзыв) работает и для встреч. И строка ссылки
-- переживает удаление события: по старой ссылке человек увидит «Встреча отменена»,
-- а не «не найдено».

ALTER TABLE calendar_events ADD COLUMN is_call BOOLEAN NOT NULL DEFAULT FALSE;

-- Соорганизатор: впускает, начинает раньше, завершает — если организатор опаздывает.
ALTER TABLE calendar_participants ADD COLUMN is_co_organizer BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE meet_guest_links
    ADD COLUMN kind           VARCHAR(16) NOT NULL DEFAULT 'guest',
    ADD COLUMN public_id      VARCHAR(16) NULL,
    ADD COLUMN ends_at        TIMESTAMPTZ NULL,
    ADD COLUMN cancelled_at   TIMESTAMPTZ NULL,
    ADD COLUMN ended_at       TIMESTAMPTZ NULL,
    -- trusted: участники сразу; waiting_room: все через зал ожидания; host_required: ждут организатора
    ADD COLUMN access_policy  VARCHAR(16) NOT NULL DEFAULT 'trusted',
    ADD COLUMN early_join_min INT NOT NULL DEFAULT 15,
    -- гости по общей ссылке (решение заказчика 05.10: остаются)
    ADD COLUMN guests_allowed BOOLEAN NOT NULL DEFAULT TRUE,
    ADD CONSTRAINT meet_links_kind_chk CHECK (kind IN ('guest', 'meeting')),
    ADD CONSTRAINT meet_links_policy_chk CHECK (access_policy IN ('trusted', 'waiting_room', 'host_required')),
    ADD CONSTRAINT meet_links_early_chk CHECK (early_join_min BETWEEN 0 AND 120);

CREATE UNIQUE INDEX uq_meet_links_public_id ON meet_guest_links (public_id) WHERE public_id IS NOT NULL;
-- у события одна ссылка-встреча
CREATE UNIQUE INDEX uq_meet_links_meeting_event ON meet_guest_links (event_id) WHERE kind = 'meeting';

-- Уже запланированные встречи с участниками (и те, где созвон уже был) — сразу со ссылкой.
UPDATE calendar_events e
   SET is_call = TRUE
 WHERE NOT e.all_day
   AND e.ends_at > now() - interval '30 days'
   AND (e.meet_room_id IS NOT NULL
        OR (SELECT count(*) FROM calendar_participants p WHERE p.event_id = e.id) > 1);

UPDATE calendar_events SET meet_room_id = gen_random_uuid()::text
 WHERE is_call AND meet_room_id IS NULL;

INSERT INTO meet_guest_links
       (tenant_id, room_id, label, token_hash, created_by, expires_at, starts_at, ends_at, event_id, kind, public_id)
SELECT e.tenant_id, e.meet_room_id, left(e.title, 120),
       encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'),
       e.owner_id,
       GREATEST(e.ends_at + interval '4 hours', e.starts_at + interval '4 hours'),
       e.starts_at, e.ends_at, e.id, 'meeting',
       substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)
  FROM calendar_events e
 WHERE e.is_call
ON CONFLICT DO NOTHING;
