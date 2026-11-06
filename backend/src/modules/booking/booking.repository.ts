import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';

export interface BookingTypeRow {
  id: string; tenant_id: string; user_id: string; slug: string; title: string; description: string | null;
  duration_min: number; weekly: Record<string, [string, string][]> | null;
  location_kind: 'call' | 'place' | 'phone'; location: string | null;
  buffer_before: number; buffer_after: number;
  questions: { text: string; required?: boolean }[]; reminders: number[]; position: number; active: boolean;
  /** #4787, п. 16: к кому запись — к себе, к любому из команды, ко всем сразу, группа */
  mode: 'personal' | 'round_robin' | 'collective' | 'group'; member_ids: string[]; rr_rule: 'nearest' | 'even'; seats: number | null;
}
export interface BookingTypePublicRow extends BookingTypeRow {
  owner_name: string; owner_avatar: string | null; owner_tz: string | null; tenant_name: string | null;
}
export interface RulesRow {
  weekly: Record<string, [string, string][]>; blocked_dates: (string | Date)[];
  vacations: { from: string; to: string }[]; max_per_day: number | null; min_notice_min: number;
  horizon_days: number; timezone: string | null;
}
export interface BookingRow {
  id: string; tenant_id: string; type_id: string; user_id: string; event_id: string | null;
  guest_name: string; guest_email: string; guest_tz: string | null; answers: { q: string; a: string }[];
  starts_at: Date; ends_at: Date; status: 'confirmed' | 'cancelled'; is_group: boolean;
}

type Q = Pick<PoolClient, 'query'> | null;

@Injectable()
export class BookingRepository {
  constructor(private readonly db: DbService) {}

  // ── виды встреч (п. 7) ──

  types(tenantId: string, userId: string) {
    return this.db.many<BookingTypeRow>(
      `SELECT * FROM booking_types WHERE tenant_id = $1 AND user_id = $2 AND active ORDER BY position, id`,
      [tenantId, userId],
    );
  }

  typeById(tenantId: string, userId: string, id: string) {
    return this.db.one<BookingTypeRow>(
      `SELECT * FROM booking_types WHERE tenant_id = $1 AND user_id = $2 AND id = $3 AND active`,
      [tenantId, userId, id],
    );
  }

  typeBySlug(slug: string) {
    return this.db.one<BookingTypePublicRow>(
      `SELECT bt.*, u.full_name AS owner_name, u.avatar_file_id AS owner_avatar,
              COALESCE(u.timezone, t.timezone) AS owner_tz, t.name AS tenant_name
         FROM booking_types bt
         JOIN users u ON u.id = bt.user_id AND u.tenant_id = bt.tenant_id
         JOIN tenants t ON t.id = bt.tenant_id
        WHERE bt.slug = $1 AND bt.active AND u.is_active IS NOT FALSE`,
      [slug],
    );
  }

  async createType(tenantId: string, userId: string, slug: string, t: {
    title: string; description: string | null; durationMin: number; weekly: unknown; locationKind: string; location: string | null;
    bufferBefore: number; bufferAfter: number; questions: unknown; reminders: number[]; position: number;
    mode?: string; memberIds?: string[]; rrRule?: string; seats?: number | null;
  }) {
    return this.db.one<BookingTypeRow>(
      `INSERT INTO booking_types (tenant_id, user_id, slug, title, description, duration_min, weekly, location_kind, location,
                                  buffer_before, buffer_after, questions, reminders, position, mode, member_ids, rr_rule, seats)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13::int[],$14,$15,$16::bigint[],$17,$18) RETURNING *`,
      [tenantId, userId, slug, t.title, t.description, t.durationMin, t.weekly == null ? null : JSON.stringify(t.weekly),
        t.locationKind, t.location, t.bufferBefore, t.bufferAfter, JSON.stringify(t.questions ?? []), t.reminders, t.position,
        t.mode ?? 'personal', t.memberIds ?? [], t.rrRule ?? 'nearest', t.seats ?? null],
    );
  }

  updateType(tenantId: string, userId: string, id: string, t: {
    title: string; description: string | null; durationMin: number; weekly: unknown; locationKind: string; location: string | null;
    bufferBefore: number; bufferAfter: number; questions: unknown; reminders: number[];
    mode?: string; memberIds?: string[]; rrRule?: string; seats?: number | null;
  }) {
    return this.db.one<BookingTypeRow>(
      `UPDATE booking_types SET title=$4, description=$5, duration_min=$6, weekly=$7::jsonb, location_kind=$8, location=$9,
              buffer_before=$10, buffer_after=$11, questions=$12::jsonb, reminders=$13::int[],
              mode=$14, member_ids=$15::bigint[], rr_rule=$16, seats=$17, updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND active RETURNING *`,
      [tenantId, userId, id, t.title, t.description, t.durationMin, t.weekly == null ? null : JSON.stringify(t.weekly),
        t.locationKind, t.location, t.bufferBefore, t.bufferAfter, JSON.stringify(t.questions ?? []), t.reminders,
        t.mode ?? 'personal', t.memberIds ?? [], t.rrRule ?? 'nearest', t.seats ?? null],
    );
  }

  /** Удаление вида — выключение: записи гостей ссылаются на него и остаются читаемыми. */
  deactivateType(tenantId: string, userId: string, id: string) {
    return this.db.query(`UPDATE booking_types SET active = FALSE, updated_at = now() WHERE tenant_id=$1 AND user_id=$2 AND id=$3`, [tenantId, userId, id]);
  }

  hasAnyType(tenantId: string, userId: string) {
    return this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM booking_types WHERE tenant_id=$1 AND user_id=$2`, [tenantId, userId])
      .then((r) => (r?.n ?? 0) > 0);
  }

  // ── правила доступности (п. 8) ──

  rules(tenantId: string, userId: string) {
    return this.db.one<RulesRow>(`SELECT * FROM booking_rules WHERE tenant_id=$1 AND user_id=$2`, [tenantId, userId]);
  }

  saveRules(tenantId: string, userId: string, r: {
    weekly: unknown; blockedDates: string[]; vacations: unknown; maxPerDay: number | null; minNoticeMin: number; horizonDays: number; timezone: string | null;
  }) {
    return this.db.query(
      `INSERT INTO booking_rules (tenant_id, user_id, weekly, blocked_dates, vacations, max_per_day, min_notice_min, horizon_days, timezone)
       VALUES ($1,$2,$3::jsonb,$4::date[],$5::jsonb,$6,$7,$8,$9)
       ON CONFLICT (user_id) DO UPDATE SET weekly=EXCLUDED.weekly, blocked_dates=EXCLUDED.blocked_dates, vacations=EXCLUDED.vacations,
         max_per_day=EXCLUDED.max_per_day, min_notice_min=EXCLUDED.min_notice_min, horizon_days=EXCLUDED.horizon_days,
         timezone=EXCLUDED.timezone, updated_at=now()`,
      [tenantId, userId, JSON.stringify(r.weekly), r.blockedDates, JSON.stringify(r.vacations), r.maxPerDay, r.minNoticeMin, r.horizonDays, r.timezone],
    );
  }

  userTz(tenantId: string, userId: string) {
    return this.db.one<{ tz: string | null; email: string; full_name: string }>(
      `SELECT COALESCE(u.timezone, t.timezone) AS tz, u.email, u.full_name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id=$1 AND u.tenant_id=$2`,
      [userId, tenantId],
    );
  }

  // ── занятость организатора: встречи, чужие календари, блоки, записи без встречи ──

  async busy(tenantId: string, userId: string, from: string, to: string, exceptBookingId?: string | null, q: Q = null) {
    const sql = `
      SELECT e.starts_at, e.ends_at, 'event' AS kind
        FROM calendar_events e
        LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
       WHERE e.tenant_id = $1 AND NOT e.all_day
         AND e.starts_at < $4::timestamptz AND e.ends_at > $3::timestamptz
         AND (e.owner_id = $2 OR (p.user_id IS NOT NULL AND p.status <> 'declined'))
         AND ($5::bigint IS NULL OR e.id IS DISTINCT FROM (SELECT event_id FROM bookings WHERE id = $5::bigint))
      UNION ALL
      SELECT x.starts_at, x.ends_at, 'external'
        FROM calendar_external_events x
        JOIN calendar_links l ON l.id = x.link_id
       WHERE x.tenant_id = $1 AND l.user_id = $2 AND l.kind IN ('import', 'google') AND NOT x.all_day
         AND x.starts_at < $4::timestamptz AND x.ends_at > $3::timestamptz
      UNION ALL
      SELECT b.starts_at, b.ends_at, 'block'
        FROM calendar_blocks b
       WHERE b.tenant_id = $1 AND b.user_id = $2
         AND b.starts_at < $4::timestamptz AND b.ends_at > $3::timestamptz
      UNION ALL
      SELECT k.starts_at, k.ends_at, 'booking'
        FROM bookings k
       WHERE k.tenant_id = $1 AND k.user_id = $2 AND k.status = 'confirmed' AND k.event_id IS NULL
         AND k.starts_at < $4::timestamptz AND k.ends_at > $3::timestamptz
         AND ($5::bigint IS NULL OR k.id <> $5::bigint)`;
    const params = [tenantId, userId, from, to, exceptBookingId ?? null];
    const rows = q ? (await q.query(sql, params)).rows : await this.db.many(sql, params);
    return rows as { starts_at: Date; ends_at: Date; kind: string }[];
  }

  // ── записи гостей (п. 6, 9) ──

  /**
   * Запись под замком на человека: два гостя одновременно не займут одно время (п. 6).
   * Внутри замка ещё раз смотрим занятость — то, что успели занять, пока гость выбирал.
   */
  async reserve(tenantId: string, userId: string, check: (busy: { starts_at: Date; ends_at: Date }[]) => boolean, row: {
    typeId: string; guestName: string; guestEmail: string; guestTz: string | null; answers: unknown; startsAt: string; endsAt: string; manageHash: string;
  }): Promise<BookingRow | null> {
    return this.db.withTransaction(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('booking:' || $1::text))`, [userId]);
      const from = new Date(Date.parse(row.startsAt) - 86_400_000).toISOString();
      const to = new Date(Date.parse(row.endsAt) + 86_400_000).toISOString();
      const busy = await this.busy(tenantId, userId, from, to, null, c);
      if (!check(busy)) return null;
      const r = await c.query(
        `INSERT INTO bookings (tenant_id, type_id, user_id, guest_name, guest_email, guest_tz, answers, starts_at, ends_at, manage_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
         ON CONFLICT DO NOTHING RETURNING *`,
        [tenantId, row.typeId, userId, row.guestName, row.guestEmail, row.guestTz, JSON.stringify(row.answers ?? []), row.startsAt, row.endsAt, row.manageHash],
      );
      return (r.rows[0] as BookingRow | undefined) ?? null;
    });
  }

  /** Перенос — тем же замком и той же проверкой, но без самой записи в занятости. */
  async move(tenantId: string, userId: string, id: string, check: (busy: { starts_at: Date; ends_at: Date }[]) => boolean, startsAt: string, endsAt: string) {
    return this.db.withTransaction(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('booking:' || $1::text))`, [userId]);
      const from = new Date(Date.parse(startsAt) - 86_400_000).toISOString();
      const to = new Date(Date.parse(endsAt) + 86_400_000).toISOString();
      const busy = await this.busy(tenantId, userId, from, to, id, c);
      if (!check(busy)) return false;
      const r = await c.query(
        `UPDATE bookings SET starts_at=$3, ends_at=$4, updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='confirmed' RETURNING id`,
        [tenantId, id, startsAt, endsAt],
      );
      return r.rows.length > 0;
    });
  }

  setEvent(id: string, eventId: string) {
    return this.db.query(`UPDATE bookings SET event_id=$2, updated_at=now() WHERE id=$1`, [id, eventId]);
  }

  cancel(id: string) {
    return this.db.query(`UPDATE bookings SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1 AND status='confirmed'`, [id]);
  }

  byManageHash(hash: string) {
    return this.db.one<BookingRow>(`SELECT * FROM bookings WHERE manage_hash=$1`, [hash]);
  }

  typeOf(id: string) {
    return this.db.one<BookingTypePublicRow>(
      `SELECT bt.*, u.full_name AS owner_name, u.avatar_file_id AS owner_avatar,
              COALESCE(u.timezone, t.timezone) AS owner_tz, t.name AS tenant_name
         FROM booking_types bt JOIN users u ON u.id = bt.user_id JOIN tenants t ON t.id = bt.tenant_id WHERE bt.id=$1`,
      [id],
    );
  }

  upcoming(tenantId: string, userId: string) {
    return this.db.many<BookingRow & { type_title: string }>(
      `SELECT k.*, bt.title AS type_title FROM bookings k JOIN booking_types bt ON bt.id = k.type_id
        WHERE k.tenant_id=$1 AND k.user_id=$2 AND k.status='confirmed' AND k.ends_at > now() ORDER BY k.starts_at LIMIT 50`,
      [tenantId, userId],
    );
  }

  mail(tenantId: string, toEmail: string, subject: string, text: string, key: string, dedup: string, attachments?: unknown) {
    return this.db.query(
      `INSERT INTO mail_outbox (tenant_id, user_id, to_email, subject, body_text, body_html, event_key, dedup_key, attachments)
       VALUES ($1, NULL, $2, $3, $4, NULL, $5, $6, $7) ON CONFLICT (dedup_key) DO NOTHING`,
      [tenantId, toEmail, subject.slice(0, 255), text, key, dedup.slice(0, 160), attachments ? JSON.stringify(attachments) : null],
    );
  }

  // ── командная и групповая запись (п. 16) ──

  /** Сотрудники компании среди переданных — для состава команды вида встречи. */
  teamMembers(tenantId: string, ids: string[]) {
    if (!ids.length) return Promise.resolve([] as { id: string; full_name: string }[]);
    return this.db.many<{ id: string; full_name: string }>(
      `SELECT u.id::text, u.full_name FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.id = ANY($2::bigint[]) AND u.is_active AND r.code <> 'client'`,
      [tenantId, ids],
    );
  }

  /**
   * Запись под замком на всех, кого она касается (п. 6, 16): ведущий, а у записи «ко
   * всем сразу» — каждый участник. Занятость каждого смотрим внутри замка.
   */
  async reserveFor(tenantId: string, lockIds: string[], check: (busy: Record<string, { starts_at: Date; ends_at: Date; kind: string }[]>) => boolean, row: {
    typeId: string; hostId: string; guestName: string; guestEmail: string; guestTz: string | null; answers: unknown;
    startsAt: string; endsAt: string; manageHash: string; isGroup?: boolean; eventId?: string | null; exceptBookingId?: string | null;
  }): Promise<BookingRow | null> {
    return this.db.withTransaction(async (c) => {
      for (const id of [...new Set(lockIds)].sort()) await c.query(`SELECT pg_advisory_xact_lock(hashtext('booking:' || $1::text))`, [id]);
      const from = new Date(Date.parse(row.startsAt) - 86_400_000).toISOString();
      const to = new Date(Date.parse(row.endsAt) + 86_400_000).toISOString();
      const busy: Record<string, { starts_at: Date; ends_at: Date; kind: string }[]> = {};
      for (const id of new Set(lockIds)) busy[id] = await this.busy(tenantId, id, from, to, row.exceptBookingId ?? null, c);
      if (!check(busy)) return null;
      const r = await c.query(
        `INSERT INTO bookings (tenant_id, type_id, user_id, guest_name, guest_email, guest_tz, answers, starts_at, ends_at, manage_hash, is_group, event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING RETURNING *`,
        [tenantId, row.typeId, row.hostId, row.guestName, row.guestEmail, row.guestTz, JSON.stringify(row.answers ?? []),
          row.startsAt, row.endsAt, row.manageHash, !!row.isGroup, row.eventId ?? null],
      );
      return (r.rows[0] as BookingRow | undefined) ?? null;
    });
  }

  /** Потоки групповой встречи: время, событие и сколько мест занято. */
  groupSessions(typeId: string, exceptBookingId?: string | null) {
    return this.db.many<{ starts_at: Date; event_id: string | null; taken: number }>(
      `SELECT starts_at, max(event_id)::text AS event_id, count(*)::int AS taken FROM bookings
        WHERE type_id = $1 AND status = 'confirmed' AND is_group AND ($2::bigint IS NULL OR id <> $2::bigint)
        GROUP BY starts_at`,
      [typeId, exceptBookingId ?? null],
    );
  }

  /** Сколько записей этого вида у сотрудника за месяц — для «равномерного распределения». */
  async recentCount(typeId: string, hostId: string) {
    const r = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings WHERE type_id = $1 AND user_id = $2 AND status = 'confirmed' AND created_at > now() - interval '30 days'`,
      [typeId, hostId],
    );
    return r?.n ?? 0;
  }

  /**
   * Перенос с новым местом (п. 9, 16): временная запись держала новый слот — она уходит,
   * а исходная (с той же ссылкой «перенести/отменить») получает её место. Одной транзакцией.
   */
  swapIn(origId: string, tempId: string, hostId: string, startsAt: string, endsAt: string, eventId: string | null) {
    return this.db.withTransaction(async (c) => {
      await c.query(`DELETE FROM bookings WHERE id = $1`, [tempId]);
      await c.query(
        `UPDATE bookings SET status='confirmed', cancelled_at=NULL, user_id=$2, starts_at=$3, ends_at=$4, event_id=$5, updated_at=now() WHERE id=$1`,
        [origId, hostId, startsAt, endsAt, eventId],
      );
    });
  }

  /** Перенос не удался — запись возвращается как была. */
  restore(id: string) {
    return this.db.query(`UPDATE bookings SET status='confirmed', cancelled_at=NULL, updated_at=now() WHERE id=$1`, [id]);
  }

  confirmedOnEvent(eventId: string) {
    return this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE event_id = $1 AND status = 'confirmed'`, [eventId]).then((r) => r?.n ?? 0);
  }
}
