import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { emitCalendarChange } from './calendar-hooks';
import { CalendarRepository, EventRow } from './calendar.repository';
import { CalendarService } from './calendar.service';
import { occurrences, REPEAT_FREQS, RepeatFreq } from './recurrence';

type Viewer = { userId: string; role: string };
export type SeriesScope = 'one' | 'following' | 'all';

/**
 * Повторяющиеся встречи (#4787, п. 17).
 *
 * Серия — это обычные встречи с общим series_id. Первая создаётся обычным путём
 * (приглашения участникам уходят один раз), остальные — её копии без писем.
 * Правка и удаление спрашивают: только эту, эту и последующие или всю серию.
 */
@Injectable()
export class CalendarSeriesService {
  constructor(
    private readonly db: DbService,
    private readonly repo: CalendarRepository,
    private readonly calendar: CalendarService,
  ) {}

  private async tzOf(tenantId: string, userId: string) {
    const r = await this.db.one<{ tz: string | null }>(
      `SELECT COALESCE(u.timezone, t.timezone) AS tz FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1 AND u.tenant_id = $2`,
      [userId, tenantId],
    );
    return r?.tz || 'Europe/Moscow';
  }

  async create(tenantId: string, user: Viewer, dto: Parameters<CalendarService['create']>[2] & { repeat?: { freq: RepeatFreq; until?: string | null; count?: number | null } | null }) {
    const { repeat, ...base } = dto;
    if (!repeat || !REPEAT_FREQS.includes(repeat.freq)) return this.calendar.create(tenantId, user, base);
    const first = await this.calendar.create(tenantId, user, base) as { id: string };
    const row = await this.repo.byId(tenantId, String(first.id)) as EventRow & Record<string, any>;
    const start = new Date(row.starts_at).getTime();
    const dur = new Date(row.ends_at).getTime() - start;
    const times = occurrences(start, repeat.freq, await this.tzOf(tenantId, user.userId), { until: repeat.until, count: repeat.count });
    const participants = await this.repo.participantsFor(tenantId, [String(row.id)]);
    const reminders = (await this.repo.remindersOf([String(row.id)])).get(String(row.id)) ?? [];
    const seriesId = randomUUID();
    const ids = [String(row.id)];
    for (const t of times.slice(1)) {
      const copy = await this.repo.create({
        tenantId, scope: row.scope, ownerId: String(row.owner_id), title: row.title, description: row.description, location: row.location,
        meetRoomId: null, startsAt: new Date(t).toISOString(), endsAt: new Date(t + dur).toISOString(), allDay: row.all_day,
        color: row.color, isPrivate: row.is_private, createdBy: user.userId,
        participantIds: participants.filter((p) => !p.is_organizer).map((p) => String(p.user_id)),
        coOrganizerIds: participants.filter((p) => p.is_co_organizer).map((p) => String(p.user_id)),
        isCall: !!row.is_call, clientId: row.client_id ? String(row.client_id) : null,
        meeting: { accessPolicy: row.access_policy ?? undefined, earlyJoinMin: row.early_join_min ?? undefined, guestsAllowed: row.guests_allowed ?? undefined } as never,
      });
      await this.repo.setReminders(String(copy.id), reminders);
      ids.push(String(copy.id));
      void emitCalendarChange(tenantId, String(copy.id), 'saved');
    }
    await this.db.query(`UPDATE calendar_events SET series_id = $2, series_rule = $3 WHERE tenant_id = $1 AND id = ANY($4::bigint[])`,
      [tenantId, seriesId, repeat.freq, ids]);
    return { ...(await this.calendar.details(tenantId, user, String(row.id))), seriesCount: ids.length };
  }

  /** Встречи серии в охвате: эта, эта и следующие, вся серия. */
  private async scopeRows(tenantId: string, id: string, scope: SeriesScope) {
    const me = await this.db.one<{ id: string; series_id: string | null; starts_at: Date }>(
      `SELECT id::text, series_id::text, starts_at FROM calendar_events WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    if (!me) throw AppException.notFound('Событие не найдено');
    if (!me.series_id || scope === 'one') return { me, rows: [me] };
    const rows = await this.db.many<{ id: string; series_id: string | null; starts_at: Date }>(
      `SELECT id::text, series_id::text, starts_at FROM calendar_events
        WHERE tenant_id = $1 AND series_id = $2 AND ($3::text = 'all' OR starts_at >= $4)
        ORDER BY starts_at`,
      [tenantId, me.series_id, scope, me.starts_at],
    );
    return { me, rows };
  }

  async update(tenantId: string, user: Viewer, id: string, dto: Parameters<CalendarService['update']>[3], scope: SeriesScope = 'one') {
    const { me, rows } = await this.scopeRows(tenantId, id, scope);
    if (rows.length <= 1) return this.calendar.update(tenantId, user, id, dto);
    // время — сдвигом: «перенести серию на час позже» двигает каждую встречу на час, а не ставит все на одну дату
    const d = dto as { startsAt?: string; endsAt?: string };
    const shift = d.startsAt ? Date.parse(d.startsAt) - new Date(me.starts_at).getTime() : 0;
    const dur = d.startsAt && d.endsAt ? Date.parse(d.endsAt) - Date.parse(d.startsAt) : null;
    let mine: unknown = null;
    for (const r of rows) {
      const own = await this.repo.byId(tenantId, r.id);
      if (!own) continue;
      const s = new Date(own.starts_at).getTime() + shift;
      const patch = { ...dto } as Record<string, unknown>;
      if (d.startsAt) {
        patch.startsAt = new Date(s).toISOString();
        patch.endsAt = new Date(s + (dur ?? new Date(own.ends_at).getTime() - new Date(own.starts_at).getTime())).toISOString();
      }
      const res = await this.calendar.update(tenantId, user, r.id, patch as typeof dto);
      if (r.id === String(id)) mine = res;
    }
    // «эту и последующие» с новым временем — дальше это уже своя серия
    if (scope === 'following' && rows[0].id === String(id) && me.series_id && shift) {
      await this.db.query(`UPDATE calendar_events SET series_id = $3 WHERE tenant_id = $1 AND id = ANY($2::bigint[])`,
        [tenantId, rows.map((r) => r.id), randomUUID()]);
    }
    return mine;
  }

  async remove(tenantId: string, user: Viewer, id: string, scope: SeriesScope = 'one') {
    const { rows } = await this.scopeRows(tenantId, id, scope);
    // письмо об отмене — одно, по той встрече, где нажали; остальные уходят без писем
    await this.calendar.remove(tenantId, user, id);
    for (const r of rows) {
      if (r.id === String(id)) continue;
      await emitCalendarChange(tenantId, r.id, 'removed');
      await this.repo.remove(tenantId, r.id);
    }
    return { deleted: true, count: rows.length };
  }
}
