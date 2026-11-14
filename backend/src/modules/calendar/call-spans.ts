/**
 * #4920: созвоны QEVO — тоже встречи для занятости, подбора времени и аналитики.
 *
 * Созвон из журнала, у которого нет встречи в календаре (её комната — у события): такой
 * считаем отдельно, а со встречей — уже посчитан самой встречей. Таблица — `c` (call_log).
 */
export const CALL_WITHOUT_EVENT = `NOT EXISTS (SELECT 1 FROM calendar_events e WHERE e.tenant_id = c.tenant_id AND e.meet_room_id = c.room_id)
          AND NOT EXISTS (SELECT 1 FROM meet_guest_links ml WHERE ml.tenant_id = c.tenant_id AND ml.room_id = c.room_id AND ml.event_id IS NOT NULL)`;

/** Интервалы созвонов людей ($2 — массив id) в промежутке [$3, $4) — для UNION с событиями. */
export const CALL_SPANS_SQL = `SELECT u.uid AS user_id, c.started_at AS starts_at,
              COALESCE(c.ended_at, GREATEST(now(), c.started_at + interval '15 minutes')) AS ends_at
         FROM call_log c CROSS JOIN LATERAL unnest(c.participant_ids) AS u(uid)
        WHERE c.tenant_id = $1 AND u.uid = ANY($2::bigint[])
          AND c.started_at < $4::timestamptz AND COALESCE(c.ended_at, now()) > $3::timestamptz
          AND ${CALL_WITHOUT_EVENT}`;
