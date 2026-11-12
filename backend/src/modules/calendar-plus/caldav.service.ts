import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { runsBackground } from '../../common/process-role';
import { DbService } from '../../database/db.service';
import { CalendarChange, onCalendarChange } from '../calendar/calendar-hooks';
import { CalendarMailService } from '../calendar/calendar-mail.service';
import { CalendarRepository } from '../calendar/calendar.repository';
import { buildIcs, icsUid } from '../calendar/ics';
import { parseIcs } from '../calendar/ics-parse';
import { IntegrationCryptoService } from '../integrations/crypto.service';

const YANDEX = 'https://caldav.yandex.ru';
const BACK_DAYS = 30;
const FORWARD_DAYS = 180;

interface Account { user_id: string; tenant_id: string; login: string; password_enc: string; calendar_url: string }

/** Ответ CalDAV — XML; нужные куски достаём без парсера: структура у Яндекса стабильная. */
const tagValues = (xml: string, tag: string) => {
  const re = new RegExp(`<(?:[a-zA-Z]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z]+:)?${tag}>`, 'g');
  const out: string[] = [];
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
  return out;
};
const unescapeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * Яндекс Календарь по CalDAV (#4892, п. 1). Двусторонне:
 *  - встречи QEVO → в выбранный календарь Яндекса (копия, с нашим UID — не дублируются);
 *  - события Яндекса → в календарь QEVO, только для чтения (свои копии обратно не тянем).
 * При отключении удаляем всё, что QEVO положил в Яндекс, — без «призрачных» событий.
 * Вход — логин и пароль приложения Яндекса (OAuth CalDAV не принимает).
 */
@Injectable()
export class CaldavService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('YandexCalendar');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly db: DbService,
    private readonly crypto: IntegrationCryptoService,
    private readonly calendar: CalendarRepository,
    private readonly mail: CalendarMailService,
  ) {}

  onModuleInit(): void {
    onCalendarChange((tenantId, eventId, change) => this.onChange(tenantId, eventId, change));
    if (!runsBackground()) return;
    this.timer = setInterval(() => void this.tick(), 10 * 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  private auth(a: { login: string; password: string }) {
    return `Basic ${Buffer.from(`${a.login}:${a.password}`).toString('base64')}`;
  }

  private async dav(url: string, method: string, auth: string, body?: string, headers: Record<string, string> = {}) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/xml; charset=utf-8', ...headers },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401 || res.status === 403) throw AppException.validation('Яндекс не принял логин или пароль приложения');
    return { status: res.status, text: await res.text(), etag: res.headers.get('etag') };
  }

  /** Поиск календаря: пользователь → домашняя папка календарей → первый календарь событий. */
  private async discover(login: string, password: string): Promise<{ url: string; title: string | null }> {
    const auth = this.auth({ login, password });
    const principal = await this.dav(`${YANDEX}/`, 'PROPFIND', auth,
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', { Depth: '0' });
    const href = tagValues(tagValues(principal.text, 'current-user-principal')[0] ?? '', 'href')[0];
    const home = href
      ? tagValues(tagValues((await this.dav(`${YANDEX}${href}`, 'PROPFIND', auth,
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>', { Depth: '0' })).text, 'calendar-home-set')[0] ?? '', 'href')[0]
      : null;
    const homeUrl = home ? `${YANDEX}${home}` : `${YANDEX}/calendars/${encodeURIComponent(login)}/`;
    const list = await this.dav(homeUrl, 'PROPFIND', auth,
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>', { Depth: '1' });
    for (const r of tagValues(list.text, 'response')) {
      if (!/calendar\s*\/?>/.test(r) && !/<[a-zA-Z]*:?calendar\b/.test(tagValues(r, 'resourcetype')[0] ?? '')) continue;
      if (/supported-calendar-component-set/.test(r) && !/VEVENT/.test(r)) continue;
      const h = tagValues(r, 'href')[0];
      if (!h) continue;
      return { url: h.startsWith('http') ? h : `${YANDEX}${h}`, title: unescapeXml(tagValues(r, 'displayname')[0] ?? '') || null };
    }
    throw AppException.validation('В Яндекс Календаре не нашлось календаря для событий');
  }

  status(userId: string) {
    return this.db.one<{ login: string; calendar_title: string | null; last_sync_at: Date | null; last_error: string | null }>(
      `SELECT login, calendar_title, last_sync_at, last_error FROM calendar_caldav_accounts WHERE user_id = $1`, [userId]);
  }

  async connect(tenantId: string, userId: string, login: string, password: string) {
    const l = (login ?? '').trim();
    const p = (password ?? '').trim();
    if (!l || !p) throw AppException.validation('Укажите логин Яндекса и пароль приложения');
    const cal = await this.discover(l, p);
    await this.db.query(
      `INSERT INTO calendar_caldav_accounts (user_id, tenant_id, provider, login, password_enc, calendar_url, calendar_title)
       VALUES ($1, $2, 'yandex', $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET login = EXCLUDED.login, password_enc = EXCLUDED.password_enc,
          calendar_url = EXCLUDED.calendar_url, calendar_title = EXCLUDED.calendar_title, last_error = NULL`,
      [userId, tenantId, l, this.crypto.encrypt(p), cal.url, cal.title],
    );
    const exists = await this.db.one<{ id: string }>(`SELECT id::text FROM calendar_links WHERE user_id = $1 AND kind = 'yandex'`, [userId]);
    if (!exists) {
      await this.db.query(
        `INSERT INTO calendar_links (tenant_id, user_id, kind, title) VALUES ($1, $2, 'yandex', $3)`,
        [tenantId, userId, cal.title ? `Яндекс · ${cal.title}`.slice(0, 120) : 'Яндекс Календарь']);
    }
    const acc = await this.account(userId);
    if (acc) {
      await this.pull(acc).catch((e) => this.log.warn(`первое чтение Яндекса: ${(e as Error).message}`));
      await this.pushUpcoming(acc).catch((e) => this.log.warn(`первая выгрузка в Яндекс: ${(e as Error).message}`));
    }
    return { connected: true, calendar: cal.title };
  }

  /** Отключение: сначала убираем из Яндекса всё, что положил QEVO, потом — доступ. */
  async disconnect(tenantId: string, userId: string) {
    const acc = await this.account(userId);
    if (acc) {
      const auth = this.auth({ login: acc.login, password: this.crypto.decrypt(acc.password_enc) });
      const rows = await this.db.many<{ href: string }>(`SELECT href FROM calendar_caldav_events WHERE user_id = $1`, [userId]);
      for (const r of rows) await this.dav(r.href, 'DELETE', auth).catch(() => undefined);
    }
    await this.db.query(`DELETE FROM calendar_caldav_events WHERE user_id = $1`, [userId]);
    await this.db.query(`DELETE FROM calendar_links WHERE user_id = $1 AND kind = 'yandex'`, [userId]);
    await this.db.query(`DELETE FROM calendar_caldav_accounts WHERE user_id = $1`, [userId]);
    void tenantId;
    return { disconnected: true };
  }

  private account(userId: string) {
    return this.db.one<Account>(`SELECT user_id::text, tenant_id::text, login, password_enc, calendar_url FROM calendar_caldav_accounts WHERE user_id = $1`, [userId]);
  }

  /** Встреча изменилась — копия у каждого участника с Яндексом. */
  private async onChange(tenantId: string, eventId: string, change: CalendarChange) {
    const accounts = await this.db.many<Account & { going: boolean }>(
      `SELECT a.user_id::text, a.tenant_id::text, a.login, a.password_enc, a.calendar_url,
              EXISTS (SELECT 1 FROM calendar_participants p WHERE p.event_id = $2 AND p.user_id = a.user_id AND p.status <> 'declined')
                OR EXISTS (SELECT 1 FROM calendar_events e WHERE e.id = $2 AND e.owner_id = a.user_id) AS going
         FROM calendar_caldav_accounts a
        WHERE a.tenant_id = $1 AND (
          EXISTS (SELECT 1 FROM calendar_participants p WHERE p.event_id = $2 AND p.user_id = a.user_id)
          OR EXISTS (SELECT 1 FROM calendar_events e WHERE e.id = $2 AND e.owner_id = a.user_id)
          OR EXISTS (SELECT 1 FROM calendar_caldav_events c WHERE c.user_id = a.user_id AND c.event_id = $2))`,
      [tenantId, eventId]);
    for (const a of accounts) {
      if (change === 'removed' || !a.going) await this.deleteCopy(a, eventId).catch(() => undefined);
      else await this.pushOne(a, eventId).catch((e) => this.fail(a.user_id, e));
    }
  }

  private async pushOne(a: Account, eventId: string) {
    const ev = await this.calendar.byId(a.tenant_id, eventId);
    if (!ev) return;
    const uid = icsUid(a.tenant_id, eventId);
    const body = buildIcs({
      uid, title: ev.title, description: ev.description, location: ev.location,
      startsAt: ev.starts_at, endsAt: ev.ends_at, allDay: ev.all_day,
      url: ev.is_call ? this.mail.meetUrl(ev.public_id) : null,
    }).replace(/^METHOD:.*\r?\n/m, '');
    const known = await this.db.one<{ href: string }>(`SELECT href FROM calendar_caldav_events WHERE user_id = $1 AND event_id = $2`, [a.user_id, eventId]);
    const href = known?.href ?? `${a.calendar_url.replace(/\/?$/, '/')}${encodeURIComponent(uid)}.ics`;
    const auth = this.auth({ login: a.login, password: this.crypto.decrypt(a.password_enc) });
    const r = await this.dav(href, 'PUT', auth, body, { 'Content-Type': 'text/calendar; charset=utf-8' });
    if (r.status >= 300) throw new Error(`PUT ${r.status}`);
    await this.db.query(
      `INSERT INTO calendar_caldav_events (user_id, event_id, href, starts_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, event_id) DO UPDATE SET href = EXCLUDED.href, starts_at = EXCLUDED.starts_at, updated_at = now()`,
      [a.user_id, eventId, href, ev.starts_at]);
  }

  private async deleteCopy(a: Account, eventId: string) {
    const known = await this.db.one<{ href: string }>(`SELECT href FROM calendar_caldav_events WHERE user_id = $1 AND event_id = $2`, [a.user_id, eventId]);
    if (!known) return;
    const auth = this.auth({ login: a.login, password: this.crypto.decrypt(a.password_enc) });
    await this.dav(known.href, 'DELETE', auth).catch(() => undefined);
    await this.db.query(`DELETE FROM calendar_caldav_events WHERE user_id = $1 AND event_id = $2`, [a.user_id, eventId]);
  }

  private async pushUpcoming(a: Account) {
    const rows = await this.db.many<{ id: string }>(
      `SELECT DISTINCT e.id::text FROM calendar_events e LEFT JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
        WHERE e.tenant_id = $1 AND e.ends_at > now() AND e.starts_at < now() + interval '60 days'
          AND (e.owner_id = $2 OR (p.user_id IS NOT NULL AND p.status <> 'declined')) LIMIT 200`,
      [a.tenant_id, a.user_id]);
    for (const r of rows) await this.pushOne(a, r.id).catch(() => undefined);
  }

  /** Чтение Яндекса: события окна → слой «чужие встречи», свои копии пропускаем. */
  private async pull(a: Account) {
    const auth = this.auth({ login: a.login, password: this.crypto.decrypt(a.password_enc) });
    const from = new Date(Date.now() - BACK_DAYS * 86_400_000);
    const to = new Date(Date.now() + FORWARD_DAYS * 86_400_000);
    const z = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const r = await this.dav(a.calendar_url, 'REPORT', auth,
      `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop>`
      + `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${z(from)}" end="${z(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
      { Depth: '1' });
    const link = await this.db.one<{ id: string }>(`SELECT id::text FROM calendar_links WHERE user_id = $1 AND kind = 'yandex'`, [a.user_id]);
    if (!link) return 0;
    // свои копии (UID вида teamcrm-<пространство>-<встреча>@…) обратно не тянем — иначе дубль
    const events = tagValues(r.text, 'calendar-data').flatMap((raw) => parseIcs(unescapeXml(raw), from, to))
      .filter((e) => !/^teamcrm-\d+-\d+@/i.test(e.uid));
    await this.db.query(`DELETE FROM calendar_external_events WHERE link_id = $1`, [link.id]);
    for (const e of events) {
      await this.db.query(
        `INSERT INTO calendar_external_events (tenant_id, link_id, uid, title, location, starts_at, ends_at, all_day)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (link_id, uid) DO NOTHING`,
        [a.tenant_id, link.id, e.uid.slice(0, 300), e.title.slice(0, 500), e.location, e.startsAt, e.endsAt, e.allDay]);
    }
    await this.db.query(`UPDATE calendar_links SET last_sync_at = now(), last_error = NULL, events_count = $2, updated_at = now() WHERE id = $1`, [link.id, events.length]);
    await this.db.query(`UPDATE calendar_caldav_accounts SET last_sync_at = now(), last_error = NULL WHERE user_id = $1`, [a.user_id]);
    return events.length;
  }

  async syncNow(userId: string) {
    const a = await this.account(userId);
    if (!a) throw AppException.notFound('Яндекс Календарь не подключён');
    return { pulled: await this.pull(a) };
  }

  private async fail(userId: string, e: unknown) {
    this.log.warn(`Яндекс Календарь ${userId}: ${(e as Error).message}`);
    await this.db.query(`UPDATE calendar_caldav_accounts SET last_error = $2 WHERE user_id = $1`, [userId, String((e as Error).message).slice(0, 300)]).catch(() => undefined);
  }

  async tick() {
    const rows = await this.db.many<Account>(
      `SELECT user_id::text, tenant_id::text, login, password_enc, calendar_url FROM calendar_caldav_accounts
        WHERE last_sync_at IS NULL OR last_sync_at < now() - interval '10 minutes' ORDER BY last_sync_at NULLS FIRST LIMIT 30`);
    for (const a of rows) await this.pull(a).catch((e) => this.fail(a.user_id, e));
  }
}
