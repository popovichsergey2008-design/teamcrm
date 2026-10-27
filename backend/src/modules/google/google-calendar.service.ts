import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { CalendarRepository, EventRow } from '../calendar/calendar.repository';
import { CalendarChange, onCalendarChange } from '../calendar/calendar-hooks';
import { GoogleApiError, googleJson, grantedServices } from './google-api';
import { GoogleAccountRow, GoogleAuthService } from './google-auth.service';
import { googleEventBody, pulledEvent } from './google-calendar.rules';

const CAL = 'https://www.googleapis.com/calendar/v3';
/** Окно чтения Google — как у подписки по ссылке: месяц назад и полгода вперёд. */
const BACK_DAYS = 30;
const FORWARD_DAYS = 180;

interface SettingsRow {
  user_id: string; tenant_id: string; calendar_id: string; calendar_title: string | null;
  push_meetings: boolean; pull_events: boolean; sync_token: string | null;
  last_pull_at: Date | null; last_error: string | null;
}

/**
 * Google Календарь человека (#1565, §62–78 ТЗ).
 *
 *  - НАШИ ВСТРЕЧИ → GOOGLE. Встреча QEVO кладётся в Google Календарь каждого участника,
 *    кто подключил Google. Это его копия, без приглашений по почте: приглашения уже
 *    шлёт QEVO, и второе письмо от Google стало бы сюрпризом (§69). Источник правды —
 *    QEVO (§77): правка встречи у нас переписывает событие в Google, обратно не тянем.
 *  - GOOGLE → НАМ. События Google видны в календаре QEVO рядом с нашими, только для
 *    чтения — тем же слоем, что и подписка по ссылке (calendar_external_events), чтобы
 *    не назначать встречу на занятое время. Читаем по syncToken — только изменения (§73).
 */
@Injectable()
export class GoogleCalendarService implements OnModuleInit {
  private readonly log = new Logger('GoogleCalendar');

  constructor(
    private readonly db: DbService,
    private readonly auth: GoogleAuthService,
    private readonly calendar: CalendarRepository,
  ) {}

  onModuleInit() {
    onCalendarChange((tenantId, eventId, change) => this.onChange(tenantId, eventId, change));
  }

  private settings(userId: string) {
    return this.db.one<SettingsRow>(`SELECT * FROM google_calendar_settings WHERE user_id=$1`, [userId]);
  }

  async getSettings(tenantId: string, userId: string) {
    const s = await this.settings(userId);
    return s ? {
      calendarId: s.calendar_id, calendarTitle: s.calendar_title, pushMeetings: s.push_meetings,
      pullEvents: s.pull_events, lastPullAt: s.last_pull_at, lastError: s.last_error,
    } : null;
  }

  /** Календари человека — выбрать, куда класть наши встречи (§63). */
  async calendars(tenantId: string, userId: string) {
    const { token } = await this.auth.tokenFor(tenantId, userId, 'calendar');
    const res = await googleJson<any>(`${CAL}/users/me/calendarList`, token, { query: { minAccessRole: 'writer', maxResults: 100 } });
    return (res.items ?? []).map((c: any) => ({
      id: c.primary ? 'primary' : String(c.id), title: String(c.summaryOverride ?? c.summary ?? c.id), primary: !!c.primary,
    }));
  }

  async saveSettings(tenantId: string, userId: string, dto: { calendarId?: string; calendarTitle?: string; pushMeetings?: boolean; pullEvents?: boolean }) {
    await this.auth.tokenFor(tenantId, userId, 'calendar');
    const prev = await this.settings(userId);
    const calChanged = dto.calendarId !== undefined && dto.calendarId !== (prev?.calendar_id ?? 'primary');
    if (calChanged) {
      // в новом календаре встреч ещё нет: старые копии убираем, новые положит пересинхронизация
      await this.removeAllCopies(tenantId, userId);
    }
    await this.db.query(
      `INSERT INTO google_calendar_settings (user_id, tenant_id, calendar_id, calendar_title, push_meetings, pull_events)
       VALUES ($1,$2,COALESCE($3::text,'primary'),$4::text,COALESCE($5::boolean,TRUE),COALESCE($6::boolean,TRUE))
       ON CONFLICT (user_id) DO UPDATE SET
          calendar_id=COALESCE($3::text, google_calendar_settings.calendar_id),
          calendar_title=CASE WHEN $3::text IS NULL THEN google_calendar_settings.calendar_title ELSE $4::text END,
          push_meetings=COALESCE($5::boolean, google_calendar_settings.push_meetings),
          pull_events=COALESCE($6::boolean, google_calendar_settings.pull_events),
          sync_token=CASE WHEN $3::text IS NULL THEN google_calendar_settings.sync_token ELSE NULL END,
          updated_at=now()`,
      [userId, tenantId, dto.calendarId?.slice(0, 255) ?? null, dto.calendarTitle?.slice(0, 255) ?? null,
        dto.pushMeetings ?? null, dto.pullEvents ?? null],
    );
    if (dto.pushMeetings === false) await this.removeAllCopies(tenantId, userId);
    if (dto.pullEvents === false) await this.db.query(`DELETE FROM calendar_links WHERE user_id=$1 AND kind='google'`, [userId]);
    void this.syncNow(tenantId, userId).catch(() => undefined);
    return this.getSettings(tenantId, userId);
  }

  /** «Синхронизировать сейчас»: положить свои встречи в Google и перечитать Google. */
  async syncNow(tenantId: string, userId: string) {
    const s = await this.settings(userId);
    if (!s) throw AppException.validation('Сначала подключите Google Календарь');
    let pushed = 0;
    if (s.push_meetings) pushed = await this.pushUpcoming(tenantId, userId);
    const pulled = s.pull_events ? await this.pull(s) : 0;
    return { pushed, pulled };
  }

  // ── наши встречи → Google ─────────────────────────────────────────────

  private async onChange(tenantId: string, eventId: string, change: CalendarChange) {
    if (change === 'removed') {
      const copies = await this.db.many<{ user_id: string }>(
        `SELECT user_id FROM google_calendar_events WHERE tenant_id=$1 AND calendar_event_id=$2`, [tenantId, eventId]);
      for (const c of copies) await this.deleteCopy(tenantId, c.user_id, eventId);
      return;
    }
    const event = await this.calendar.byId(tenantId, eventId);
    if (!event) return;
    const people = await this.calendar.participantContacts(tenantId, eventId);
    const inEvent = new Set(people.filter((p) => p.status !== 'declined').map((p) => String(p.user_id)));
    inEvent.add(String(event.owner_id));
    // кому положить: участники, подключившие календарь; у кого копия есть, но он больше не участник — убрать
    const targets = await this.db.many<{ user_id: string }>(
      `SELECT s.user_id FROM google_calendar_settings s JOIN google_accounts a ON a.user_id=s.user_id
        WHERE s.tenant_id=$1 AND s.push_meetings AND a.status='active' AND s.user_id = ANY($2::bigint[])`,
      [tenantId, [...inEvent]],
    );
    for (const t of targets) await this.pushOne(tenantId, t.user_id, event);
    const stale = await this.db.many<{ user_id: string }>(
      `SELECT user_id FROM google_calendar_events WHERE tenant_id=$1 AND calendar_event_id=$2 AND NOT (user_id = ANY($3::bigint[]))`,
      [tenantId, eventId, targets.map((t) => t.user_id)],
    );
    for (const s of stale) await this.deleteCopy(tenantId, s.user_id, eventId);
  }

  /** Встречи человека на ближайшие полгода — при подключении и по «Синхронизировать». */
  private async pushUpcoming(tenantId: string, userId: string): Promise<number> {
    const ids = await this.db.many<{ id: string }>(
      `SELECT e.id FROM calendar_events e
        WHERE e.tenant_id=$1 AND e.ends_at > now() AND e.starts_at < now() + interval '${FORWARD_DAYS} days'
          AND (e.owner_id=$2 OR EXISTS (SELECT 1 FROM calendar_participants p
                WHERE p.event_id=e.id AND p.user_id=$2 AND p.status <> 'declined'))
        ORDER BY e.starts_at LIMIT 300`,
      [tenantId, userId],
    );
    let n = 0;
    for (const { id } of ids) {
      const e = await this.calendar.byId(tenantId, id);
      if (e && await this.pushOne(tenantId, userId, e)) n++;
    }
    return n;
  }

  private async pushOne(tenantId: string, userId: string, event: EventRow): Promise<boolean> {
    const ctx = await this.ctx(tenantId, userId);
    if (!ctx) return false;
    const existing = await this.db.one<{ google_event_id: string; calendar_id: string }>(
      `SELECT google_event_id, calendar_id FROM google_calendar_events WHERE user_id=$1 AND calendar_event_id=$2`,
      [userId, event.id],
    );
    const body = googleEventBody(event, {
      tz: await this.timezone(tenantId),
      baseUrl: (process.env.APP_BASE_URL || 'https://app.qevo.one').replace(/\/+$/, ''),
    });
    try {
      let g: any;
      if (existing && existing.calendar_id === ctx.calendarId) {
        try {
          g = await googleJson(`${CAL}/calendars/${encodeURIComponent(ctx.calendarId)}/events/${encodeURIComponent(existing.google_event_id)}`,
            ctx.token, { method: 'PUT', body, query: { sendUpdates: 'none' } });
        } catch (e) {
          // человек удалил копию в Google руками — положим заново, а не будем падать каждый раз
          if (!(e instanceof GoogleApiError && (e.status === 404 || e.status === 410))) throw e;
        }
      }
      if (!g) {
        g = await googleJson(`${CAL}/calendars/${encodeURIComponent(ctx.calendarId)}/events`, ctx.token,
          { method: 'POST', body, query: { sendUpdates: 'none' } });
      }
      await this.db.query(
        `INSERT INTO google_calendar_events (tenant_id, user_id, calendar_event_id, calendar_id, google_event_id, html_link)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, calendar_event_id) DO UPDATE SET
            calendar_id=EXCLUDED.calendar_id, google_event_id=EXCLUDED.google_event_id,
            html_link=EXCLUDED.html_link, last_pushed_at=now()`,
        [tenantId, userId, event.id, ctx.calendarId, g.id, g.htmlLink ?? null],
      );
      return true;
    } catch (e) {
      await this.failed(userId, ctx.account, e);
      return false;
    }
  }

  private async deleteCopy(tenantId: string, userId: string, eventId: string) {
    const row = await this.db.one<{ google_event_id: string; calendar_id: string }>(
      `DELETE FROM google_calendar_events WHERE user_id=$1 AND calendar_event_id=$2 RETURNING google_event_id, calendar_id`,
      [userId, eventId],
    );
    if (!row) return;
    const ctx = await this.ctx(tenantId, userId);
    if (!ctx) return;
    await googleJson(`${CAL}/calendars/${encodeURIComponent(row.calendar_id)}/events/${encodeURIComponent(row.google_event_id)}`,
      ctx.token, { method: 'DELETE', query: { sendUpdates: 'none' } })
      .catch((e) => { if (!(e instanceof GoogleApiError && (e.status === 404 || e.status === 410))) this.log.warn(`копия не удалена: ${e.message}`); });
  }

  private async removeAllCopies(tenantId: string, userId: string) {
    const rows = await this.db.many<{ calendar_event_id: string }>(
      `SELECT calendar_event_id FROM google_calendar_events WHERE user_id=$1`, [userId]);
    for (const r of rows) await this.deleteCopy(tenantId, userId, r.calendar_event_id);
  }

  /** Аккаунт с календарём и живым токеном; нет — молча пропускаем: встреча у нас важнее копии. */
  private async ctx(tenantId: string, userId: string) {
    const account = await this.auth.account(tenantId, userId);
    if (!account || account.status !== 'active' || !grantedServices(account.scopes).calendar) return null;
    const s = await this.settings(userId);
    try {
      return { account, token: await this.auth.accessToken(account), calendarId: s?.calendar_id || 'primary' };
    } catch {
      return null;
    }
  }

  // ── Google → нам ──────────────────────────────────────────────────────

  /** Проход планировщика: читаем Google у всех, кто включил показ, начиная с самых давних. */
  async tick(): Promise<void> {
    const rows = await this.db.many<SettingsRow>(
      `SELECT s.* FROM google_calendar_settings s JOIN google_accounts a ON a.user_id=s.user_id
        WHERE s.pull_events AND a.status='active'
          AND (s.last_pull_at IS NULL OR s.last_pull_at < now() - interval '10 minutes')
        ORDER BY s.last_pull_at NULLS FIRST LIMIT 50`,
    );
    for (const s of rows) await this.pull(s).catch(() => undefined);
  }

  private async pull(s: SettingsRow): Promise<number> {
    const ctx = await this.ctx(s.tenant_id, s.user_id);
    if (!ctx) return 0;
    const linkId = await this.linkFor(s);
    const ours = new Set((await this.db.many<{ google_event_id: string }>(
      `SELECT google_event_id FROM google_calendar_events WHERE user_id=$1`, [s.user_id])).map((r) => r.google_event_id));
    let syncToken = s.sync_token;
    let pageToken: string | undefined;
    let changed = 0;
    const full = !syncToken;
    if (full) await this.db.query(`DELETE FROM calendar_external_events WHERE link_id=$1`, [linkId]);
    try {
      do {
        const query: Record<string, string | number | boolean | undefined> = syncToken
          ? { syncToken, pageToken, maxResults: 250, singleEvents: true }
          : {
            pageToken, maxResults: 250, singleEvents: true, showDeleted: false,
            timeMin: new Date(Date.now() - BACK_DAYS * 86_400_000).toISOString(),
            timeMax: new Date(Date.now() + FORWARD_DAYS * 86_400_000).toISOString(),
          };
        const res = await googleJson<any>(`${CAL}/calendars/${encodeURIComponent(ctx.calendarId)}/events`, ctx.token, { query });
        for (const item of res.items ?? []) {
          // свои же встречи, положенные нами, обратно не тянем — иначе каждая встреча двоилась бы
          const mine = ours.has(item.id) || item.extendedProperties?.private?.qevoEventId;
          const ev = mine ? null : pulledEvent(item);
          if (!ev) {
            await this.db.query(`DELETE FROM calendar_external_events WHERE link_id=$1 AND uid=$2`, [linkId, String(item.id).slice(0, 300)]);
            continue;
          }
          await this.db.query(
            `INSERT INTO calendar_external_events (tenant_id, link_id, uid, title, location, starts_at, ends_at, all_day)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (link_id, uid) DO UPDATE SET title=EXCLUDED.title, location=EXCLUDED.location,
                starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at, all_day=EXCLUDED.all_day, updated_at=now()`,
            [s.tenant_id, linkId, ev.uid, ev.title, ev.location, ev.startsAt, ev.endsAt, ev.allDay],
          );
          changed++;
        }
        pageToken = res.nextPageToken;
        if (res.nextSyncToken) syncToken = res.nextSyncToken;
      } while (pageToken);
    } catch (e) {
      // 410 — Google забыл наш syncToken: следующий проход прочитает всё заново (§73)
      if (e instanceof GoogleApiError && e.status === 410) {
        await this.db.query(`UPDATE google_calendar_settings SET sync_token=NULL WHERE user_id=$1`, [s.user_id]);
        return 0;
      }
      await this.failed(s.user_id, ctx.account, e);
      return 0;
    }
    const count = await this.db.one<{ n: string }>(`SELECT count(*)::text AS n FROM calendar_external_events WHERE link_id=$1`, [linkId]);
    await this.db.query(`UPDATE calendar_links SET last_sync_at=now(), last_error=NULL, events_count=$2, updated_at=now() WHERE id=$1`,
      [linkId, Number(count?.n ?? 0)]);
    await this.db.query(
      `UPDATE google_calendar_settings SET sync_token=$2, last_pull_at=now(), last_error=NULL WHERE user_id=$1`,
      [s.user_id, syncToken],
    );
    return changed;
  }

  /** Строка-источник для слоя «чужие встречи» — одна на человека. */
  private async linkFor(s: SettingsRow): Promise<string> {
    const found = await this.db.one<{ id: string }>(
      `SELECT id FROM calendar_links WHERE user_id=$1 AND kind='google'`, [s.user_id]);
    if (found) return found.id;
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO calendar_links (tenant_id, user_id, kind, title) VALUES ($1,$2,'google',$3) RETURNING id`,
      [s.tenant_id, s.user_id, `Google${s.calendar_title ? `: ${s.calendar_title}` : ''}`.slice(0, 120)],
    );
    return row!.id;
  }

  private async failed(userId: string, account: GoogleAccountRow, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    this.log.warn(`календарь Google user=${userId}: ${msg}`);
    if (e instanceof GoogleApiError && e.kind === 'reconnect') await this.auth.markAttention(account.id, 'Google отозвал доступ');
    await this.db.query(`UPDATE google_calendar_settings SET last_error=$2 WHERE user_id=$1`,
      [userId, e instanceof GoogleApiError && e.kind === 'scope' ? 'Не хватает разрешения на календарь — подключите его заново' : msg.slice(0, 300)]);
  }

  private async timezone(tenantId: string) {
    const r = await this.db.one<{ timezone: string | null }>(`SELECT timezone FROM tenants WHERE id=$1`, [tenantId]);
    return r?.timezone || 'Europe/Moscow';
  }
}
