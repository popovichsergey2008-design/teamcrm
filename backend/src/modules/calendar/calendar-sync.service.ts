import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { CalendarRepository } from './calendar.repository';
import { buildIcs, icsUid } from './ics';
import { ExternalEvent, parseIcs } from './ics-parse';

/** Окно синхронизации: месяц назад и полгода вперёд. Дальше календарём не пользуются. */
const BACK_DAYS = 30;
const FORWARD_DAYS = 180;
/** Раз в полчаса: чужой календарь меняется не поминутно, а частые походы Google не любит. */
const TICK_MS = 30 * 60_000;
const MAX_BYTES = 5 * 1024 * 1024;

export interface CalendarLinkRow {
  id: string; tenant_id: string; user_id: string; kind: 'export' | 'import';
  token: string | null; url_enc: string | null; title: string | null;
  last_sync_at: Date | null; last_error: string | null; events_count: number;
}

/**
 * Синхронизация календаря с внешним — Google, Outlook, Apple.
 *
 * БЕЗ OAuth и это осознанно. Приложение Google требует проверки и согласия
 * администратора домена — недели переписки ради того, что решается обычной ссылкой.
 * Работают оба нужных направления:
 *
 *  - НАШИ ВСТРЕЧИ В GOOGLE: личная секретная ссылка на .ics, которую человек добавляет
 *    в Google как «Другие календари → Подписаться по URL». Google ходит по ней сам,
 *    заголовков не шлёт — поэтому секрет живёт прямо в адресе, а отзывается заменой.
 *  - ЧУЖИЕ ВСТРЕЧИ У НАС: человек даёт «секретный адрес в формате iCal» из настроек
 *    своего Google-календаря, мы читаем его раз в полчаса и показываем встречи рядом
 *    со своими — чтобы не назначать планёрку на занятое время.
 *
 * Чего НЕТ и о чём сказано прямо: записи в чужой календарь. Без OAuth её не бывает,
 * и обещать её нельзя.
 */
@Injectable()
export class CalendarSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('CalendarSync');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly db: DbService,
    private readonly repo: CalendarRepository,
    private readonly crypto: IntegrationCryptoService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private window(): { from: Date; to: Date } {
    const now = Date.now();
    return { from: new Date(now - BACK_DAYS * 86400_000), to: new Date(now + FORWARD_DAYS * 86400_000) };
  }

  private publicBase(): string {
    const explicit = this.config.get<string>('PUBLIC_BASE_URL');
    if (explicit) return explicit.replace(/\/$/, '');
    const cors = (this.config.get<string>('CORS_ORIGIN') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return (cors.find((c) => c.startsWith('https')) ?? cors[0] ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  /** Ссылки человека: одна на выгрузку и сколько угодно на чтение чужих календарей. */
  async list(tenantId: string, userId: string) {
    const rows = await this.db.many<CalendarLinkRow>(
      `SELECT * FROM calendar_links WHERE tenant_id=$1 AND user_id=$2 ORDER BY kind, created_at`,
      [tenantId, userId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      kind: r.kind,
      title: r.title,
      // сам адрес чужого календаря обратно НЕ отдаём: он даёт доступ ко всему календарю
      url: r.kind === 'export' && r.token ? `${this.publicBase()}/api/calendar/feed/${r.token}.ics` : null,
      lastSyncAt: r.last_sync_at,
      lastError: r.last_error,
      eventsCount: r.events_count,
    }));
  }

  /**
   * Ссылка на наш календарь. Одна на человека: вторая означала бы, что первую нечем
   * отозвать. Повторный вызов возвращает ту же — новую даёт только «обновить».
   */
  async exportLink(tenantId: string, userId: string, rotate = false) {
    const existing = await this.db.one<CalendarLinkRow>(
      `SELECT * FROM calendar_links WHERE tenant_id=$1 AND user_id=$2 AND kind='export'`,
      [tenantId, userId],
    );
    const token = randomBytes(24).toString('hex');
    if (existing && !rotate) return this.list(tenantId, userId).then((l) => l.find((x) => x.kind === 'export'));
    if (existing) {
      await this.db.query(`UPDATE calendar_links SET token=$2, updated_at=now() WHERE id=$1`, [existing.id, token]);
    } else {
      await this.db.query(
        `INSERT INTO calendar_links (tenant_id, user_id, kind, token, title)
         VALUES ($1,$2,'export',$3,'Мой календарь TEAMCRM')`,
        [tenantId, userId, token],
      );
    }
    return this.list(tenantId, userId).then((l) => l.find((x) => x.kind === 'export'));
  }

  /**
   * Подключить чужой календарь по адресу .ics.
   *
   * Читаем СРАЗУ: сохранить неработающий адрес и узнать об этом через полчаса — значит
   * потерять время человека дважды. Ошибку возвращаем словами, а не кодом.
   */
  async addImport(tenantId: string, userId: string, rawUrl: string, title?: string) {
    const url = String(rawUrl ?? '').trim().replace(/^webcal:/i, 'https:');
    if (!/^https?:\/\//i.test(url)) throw AppException.validation('Нужен адрес календаря, начинающийся с https://');

    const { from, to } = this.window();
    const events = await this.fetchIcs(url, from, to); // бросит понятную ошибку, если адрес не тот

    const row = await this.db.one<{ id: string }>(
      `INSERT INTO calendar_links (tenant_id, user_id, kind, url_enc, title)
       VALUES ($1,$2,'import',$3,$4) RETURNING id`,
      [tenantId, userId, this.crypto.encrypt(url), (title ?? '').trim().slice(0, 120) || 'Google-календарь'],
    );
    await this.storeEvents(tenantId, row!.id, events);
    return { id: String(row!.id), imported: events.length };
  }

  async remove(tenantId: string, userId: string, id: string) {
    await this.db.query(
      `DELETE FROM calendar_links WHERE tenant_id=$1 AND user_id=$2 AND id=$3`,
      [tenantId, userId, id],
    );
    return { removed: true };
  }

  /** Обновить один календарь по кнопке — не дожидаясь получаса. */
  async syncOne(tenantId: string, userId: string, id: string) {
    const link = await this.db.one<CalendarLinkRow>(
      `SELECT * FROM calendar_links WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND kind='import'`,
      [tenantId, userId, id],
    );
    if (!link) throw AppException.notFound('Календарь не найден');
    return this.sync(link);
  }

  /** Проход по всем подключённым календарям. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let done = 0;
    try {
      const links = await this.db.many<CalendarLinkRow>(
        `SELECT * FROM calendar_links WHERE kind='import' ORDER BY last_sync_at NULLS FIRST LIMIT 200`,
      );
      for (const link of links) {
        try { await this.sync(link); done++; } catch { /* ошибка записана в саму ссылку */ }
      }
    } finally {
      this.busy = false;
    }
    return done;
  }

  private async sync(link: CalendarLinkRow) {
    const { from, to } = this.window();
    try {
      const url = this.crypto.decrypt(link.url_enc ?? '');
      const events = await this.fetchIcs(url, from, to);
      await this.storeEvents(link.tenant_id, link.id, events);
      return { synced: events.length };
    } catch (e) {
      // Ошибку храним при ссылке и показываем человеку: молча пустой календарь —
      // худший исход, потому что выглядит как «встреч нет».
      await this.db.query(
        `UPDATE calendar_links SET last_sync_at=now(), last_error=$2, updated_at=now() WHERE id=$1`,
        [link.id, String((e as Error).message).slice(0, 300)],
      );
      throw e;
    }
  }

  private async fetchIcs(url: string, from: Date, to: Date): Promise<ExternalEvent[]> {
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw AppException.validation(`Календарь не отвечает: ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw AppException.validation(res.status === 404
        ? 'По этому адресу календаря нет. В Google это «Секретный адрес в формате iCal» из настроек календаря'
        : `Календарь ответил ${res.status}`);
    }
    const text = (await res.text()).slice(0, MAX_BYTES);
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      throw AppException.validation('По адресу лежит не календарь. Нужна ссылка на файл .ics');
    }
    return parseIcs(text, from, to);
  }

  /**
   * Записать встречи источника.
   *
   * Заменяем окно целиком, а не дописываем: в чужом календаре встречи не только
   * появляются, но и отменяются, и оставшийся «призрак» отменённой планёрки хуже её
   * отсутствия — по нему откажутся назначать время.
   */
  private async storeEvents(tenantId: string, linkId: string, events: ExternalEvent[]) {
    const { from, to } = this.window();
    await this.db.withTransaction(async (c) => {
      await c.query(
        `DELETE FROM calendar_external_events
          WHERE tenant_id=$1 AND link_id=$2 AND starts_at >= $3 AND starts_at <= $4`,
        [tenantId, linkId, from, to],
      );
      for (const e of events.slice(0, 2000)) {
        await c.query(
          `INSERT INTO calendar_external_events (tenant_id, link_id, uid, title, location, starts_at, ends_at, all_day)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (link_id, uid) DO UPDATE SET
             title=EXCLUDED.title, location=EXCLUDED.location, starts_at=EXCLUDED.starts_at,
             ends_at=EXCLUDED.ends_at, all_day=EXCLUDED.all_day, updated_at=now()`,
          [tenantId, linkId, e.uid.slice(0, 300), e.title.slice(0, 300), e.location?.slice(0, 300) ?? null,
            e.startsAt, e.endsAt, e.allDay],
        );
      }
      await c.query(
        `UPDATE calendar_links SET last_sync_at=now(), last_error=NULL, events_count=$2, updated_at=now() WHERE id=$1`,
        [linkId, events.length],
      );
    });
  }

  /** Чужие встречи человека в промежутке — их показывает календарь наравне со своими. */
  async externalInRange(tenantId: string, userId: string, from: string, to: string) {
    return this.db.many<{
      id: string; title: string; location: string | null; starts_at: Date; ends_at: Date;
      all_day: boolean; link_title: string | null;
    }>(
      `SELECT x.id, x.title, x.location, x.starts_at, x.ends_at, x.all_day, l.title AS link_title
         FROM calendar_external_events x
         JOIN calendar_links l ON l.id = x.link_id
        WHERE x.tenant_id=$1 AND l.user_id=$2 AND l.kind='import'
          AND x.starts_at < $4::timestamptz AND x.ends_at > $3::timestamptz
        ORDER BY x.starts_at`,
      [tenantId, userId, from, to],
    );
  }

  /**
   * Личная лента .ics по секретной ссылке.
   *
   * Ходит по ней Google, а не человек: ни заголовков, ни печенья он не пришлёт —
   * поэтому вся защита в длине токена, а отзыв делается его заменой.
   */
  async feed(token: string): Promise<string> {
    const link = await this.db.one<CalendarLinkRow>(
      `SELECT * FROM calendar_links WHERE token=$1 AND kind='export'`,
      [token],
    );
    if (!link) throw AppException.notFound('Календарь не найден');
    const { from, to } = this.window();
    const rows = await this.repo.eventsInRange(
      link.tenant_id, link.user_id, from.toISOString(), to.toISOString(),
    );
    const body = rows
      .map((r) => buildIcs({
        uid: icsUid(link.tenant_id, String(r.id)),
        title: r.title,
        description: r.description,
        location: r.location,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        allDay: r.all_day,
        method: 'PUBLISH',
      }))
      // из отдельных календарей собираем один: оставляем только тела событий
      .map((ics) => ics.split('\r\n').filter((l) => !/^(BEGIN|END):VCALENDAR|^VERSION:|^PRODID:|^CALSCALE:|^METHOD:/.test(l)).join('\r\n'))
      .join('\r\n');

    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TEAMCRM//Calendar//RU',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:TEAMCRM',
      body,
      'END:VCALENDAR',
      '',
    ].filter(Boolean).join('\r\n');
  }
}
