-- #4787 (ТЗ календаря, п. 16): запись к команде и групповые встречи.
--
-- mode:
--   personal    — к самому человеку (как было);
--   round_robin — к любому доступному из member_ids, правило rr_rule: nearest — ближайший
--                 доступный (по порядку в списке), even — равномерно (у кого меньше записей);
--   collective  — сразу к нескольким: окна, где свободны все (владелец + member_ids);
--   group       — несколько гостей на одно событие, не больше seats.
ALTER TABLE booking_types
    ADD COLUMN IF NOT EXISTS mode       VARCHAR(12) NOT NULL DEFAULT 'personal' CHECK (mode IN ('personal', 'round_robin', 'collective', 'group')),
    ADD COLUMN IF NOT EXISTS member_ids BIGINT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS rr_rule    VARCHAR(8) NOT NULL DEFAULT 'nearest' CHECK (rr_rule IN ('nearest', 'even')),
    ADD COLUMN IF NOT EXISTS seats      INT NULL CHECK (seats IS NULL OR seats BETWEEN 2 AND 500);

-- user_id записи — кто ведёт встречу (у командной записи — назначенный сотрудник).
-- Групповые записи делят один слот: «один гость на слот» к ним не относится.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT FALSE;
DROP INDEX IF EXISTS uq_bookings_slot;
CREATE UNIQUE INDEX uq_bookings_slot ON bookings (user_id, starts_at) WHERE status = 'confirmed' AND NOT is_group;
