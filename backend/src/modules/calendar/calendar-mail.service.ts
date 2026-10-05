import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../../database/db.service';
import { CalendarRepository, EventRow } from './calendar.repository';
import { buildIcs, icsUid } from './ics';

/**
 * Письма календаря: приглашение, отмена и напоминание.
 *
 * Кладём в ту же очередь `mail_outbox`, что и остальная почта: у неё уже есть повторы,
 * дедупликация и отписка. Приглашение и отмена возят с собой .ics — чтобы встреча легла
 * в тот календарь, которым человек пользуется каждый день, а не осталась только у нас.
 */
@Injectable()
export class CalendarMailService {
  private readonly log = new Logger('CalendarMail');

  constructor(
    private readonly db: DbService,
    private readonly repo: CalendarRepository,
    private readonly config: ConfigService,
  ) {}

  private baseUrl(): string {
    return (this.config.get<string>('APP_BASE_URL') || 'https://anthill.team').replace(/\/+$/, '');
  }

  /** Постоянная ссылка встречи (ТЗ-14): одна на всех и навсегда. */
  meetUrl(publicId: string | null | undefined): string | null {
    return publicId ? `${this.baseUrl()}/meet/${publicId}` : null;
  }

  /**
   * Время встречи словами — В ПОЯСЕ КОМПАНИИ и с отметкой пояса.
   *
   * Раньше письмо форматировалось по часам сервера (UTC): встреча «в 09:00 по Москве»
   * приходила как «06:00». Гостю со стороны пояс подписываем: «(GMT+3)» — его часы
   * могут быть другими, а файл встречи в его календаре покажет время по его часам.
   */
  private when(event: Pick<EventRow, 'starts_at' | 'ends_at' | 'all_day'>, tz = 'Europe/Moscow'): string {
    if (event.all_day) {
      return new Date(event.starts_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: tz }) + ', весь день';
    }
    const start = new Date(event.starts_at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: tz });
    const end = new Date(event.ends_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    let zone = '';
    try {
      zone = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(new Date(event.starts_at)).find((x) => x.type === 'timeZoneName')?.value ?? '';
    } catch { /* старый движок без shortOffset — без подписи */ }
    return `${start} — ${end}${zone ? ` (${zone})` : ''}`;
  }

  private async tzOf(tenantId: string): Promise<string> {
    const row = await this.db.one<{ timezone: string | null }>(`SELECT timezone FROM tenants WHERE id=$1`, [tenantId]).catch(() => null);
    return row?.timezone || 'Europe/Moscow';
  }

  /**
   * Письмо гостю со стороны (ТЗ-14, §66): приглашение, перенос, отмена, напоминание.
   *
   * У гостя нет учётной записи — письмо и файл встречи для его календаря и есть всё
   * приглашение. Ссылка в нём — ЕГО личная: по ней он войдёт в зал ожидания под своим
   * именем, и её можно отозвать, не трогая остальных.
   */
  async sendGuest(kind: 'invite' | 'update' | 'cancel' | 'reminder', event: Pick<EventRow, 'id' | 'tenant_id' | 'title' | 'description' | 'location' | 'starts_at' | 'ends_at' | 'all_day'>,
    guest: { inviteId: string; email: string; name: string | null; url: string | null }, organizerName: string | null): Promise<void> {
    try {
      const tz = await this.tzOf(String(event.tenant_id));
      const when = this.when(event, tz);
      const hello = guest.name ? `Здравствуйте, ${guest.name}!` : 'Здравствуйте!';
      const who = organizerName ? `${organizerName} приглашает вас` : 'Вас приглашают';
      const subject = kind === 'cancel' ? `Встреча отменена: ${event.title}`
        : kind === 'update' ? `Время встречи изменено: ${event.title}`
          : kind === 'reminder' ? `Скоро встреча: ${event.title}`
            : `Приглашение на встречу: ${event.title}`;
      const lines = kind === 'cancel'
        ? [hello, '', `Встреча «${event.title}» (${when}) отменена.`]
        : [
          hello, '',
          kind === 'update' ? `Время встречи «${event.title}» изменено.` : kind === 'reminder' ? `Встреча «${event.title}» скоро начнётся.` : `${who} на видеовстречу «${event.title}».`,
          '',
          `Когда: ${when}`,
          event.location ? `Где: ${event.location}` : '',
          event.description && kind === 'invite' ? `\n${event.description}` : '',
          '',
          guest.url ? `Ваша ссылка для входа: ${guest.url}` : '',
          'Ничего устанавливать не нужно — встреча работает в браузере. Войти в зал ожидания',
          'можно незадолго до начала, организатор впустит вас.',
          kind === 'invite' ? 'К письму приложен файл встречи — им можно добавить её в свой календарь.' : '',
          kind === 'update' ? 'Ссылка осталась прежней.' : '',
        ];
      const attachments = kind === 'reminder' ? undefined : [{
        name: 'meeting.ics',
        content: Buffer.from(buildIcs({
          uid: icsUid(event.tenant_id, event.id),
          title: event.title, description: event.description, location: event.location,
          startsAt: event.starts_at, endsAt: event.ends_at, allDay: event.all_day,
          organizer: organizerName ? { name: organizerName, email: null } : null,
          attendees: [{ name: guest.name, email: guest.email }],
          method: kind === 'cancel' ? 'CANCEL' : 'REQUEST',
          sequence: Math.floor(Date.now() / 60_000) - 29_000_000 + (kind === 'cancel' ? 1 : 0),
          url: guest.url,
        }), 'utf8').toString('base64'),
      }];
      await this.db.query(
        `INSERT INTO mail_outbox (tenant_id, user_id, to_email, subject, body_text, body_html, event_key, dedup_key, attachments)
         VALUES ($1, NULL, $2, $3, $4, NULL, $5, $6, $7) ON CONFLICT (dedup_key) DO NOTHING`,
        [event.tenant_id, guest.email, subject.slice(0, 255), lines.join('\n').replace(/\n{3,}/g, '\n\n'),
          `meet.guest-${kind}`,
          `meet.guest.${kind}:${guest.inviteId}:${new Date(event.starts_at).getTime()}:${kind === 'invite' || kind === 'reminder' ? '' : Date.now()}`.slice(0, 160),
          attachments ? JSON.stringify(attachments) : null],
      );
    } catch (e) {
      this.log.warn(`письмо гостю по встрече ${event.id} не ушло: ${(e as Error).message}`);
    }
  }

  /** Приглашение или сообщение об изменении: письмо + .ics, который кладётся в любой календарь. */
  async sendInvites(event: EventRow, onlyUserIds?: string[]): Promise<void> {
    await this.send(event, 'invite', onlyUserIds);
  }

  /** Отмена: тот же UID и METHOD:CANCEL — внешний календарь уберёт встречу сам. */
  async sendCancel(event: EventRow): Promise<void> {
    await this.send(event, 'cancel');
  }

  private async send(event: EventRow, kind: 'invite' | 'cancel', onlyUserIds?: string[]): Promise<void> {
    try {
      const tz = await this.tzOf(String(event.tenant_id));
      const people = await this.repo.participantContacts(event.tenant_id, event.id);
      const organizer = people.find((p) => p.is_organizer) ?? null;
      const reminders = (await this.repo.remindersOf([event.id])).get(String(event.id)) ?? [];
      const targets = people.filter((p) => !p.is_organizer && (!onlyUserIds || onlyUserIds.includes(String(p.user_id))));
      if (!targets.length) return;

      const ics = buildIcs({
        uid: icsUid(event.tenant_id, event.id),
        title: event.title,
        description: event.description,
        location: event.location,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        allDay: event.all_day,
        organizer: organizer ? { name: organizer.full_name, email: organizer.email } : null,
        attendees: targets.map((t) => ({ name: t.full_name, email: t.email })),
        method: kind === 'cancel' ? 'CANCEL' : 'REQUEST',
        // номер правки растёт со временем: без этого внешний календарь считает письмо о
        // переносе повтором и не обновляет встречу (раньше он был всегда 1)
        sequence: Math.floor(Date.now() / 60_000) - 29_000_000 + (kind === 'cancel' ? 1 : 0),
        reminders,
        url: event.is_call ? this.meetUrl(event.public_id) : null,
      });
      const attachments = [{
        name: 'meeting.ics',
        content: Buffer.from(ics, 'utf8').toString('base64'),
      }];

      // у встречи с созвоном — её постоянная ссылка: по ней и ответить, и войти (ТЗ-14, §38)
      const meetUrl = event.is_call ? this.meetUrl(event.public_id) : null;
      const url = meetUrl ?? `${this.baseUrl()}/focus/calendar`;
      const subject = kind === 'cancel' ? `Встреча отменена: ${event.title}` : `Встреча: ${event.title}`;
      for (const p of targets) {
        const lines = kind === 'cancel'
          ? [`Встреча «${event.title}» отменена.`, this.when(event, tz)]
          : [
            `${organizer?.full_name ?? 'Коллега'} зовёт вас на встречу.`,
            '',
            event.title,
            this.when(event, tz),
            event.location ? `Место: ${event.location}` : '',
            event.description ? '' : '',
            event.description ?? '',
            '',
            meetUrl ? `Ссылка на встречу — по ней же войти в созвон: ${meetUrl}` : `Ответить и посмотреть подробности: ${url}`,
            meetUrl ? 'Ссылка не изменится, даже если время встречи перенесут.' : '',
            'К письму приложен файл встречи — им можно добавить её в свой календарь.',
          ];
        await this.enqueue({
          tenantId: event.tenant_id,
          userId: p.user_id,
          toEmail: p.email,
          subject,
          text: lines.filter((l) => l !== undefined).join('\n'),
          eventKey: kind === 'cancel' ? 'calendar.cancel' : 'calendar.invite',
          // правка встречи должна дойти повторно, поэтому в ключ входит время начала
          dedupKey: `cal.${kind}:${event.id}:${p.user_id}:${new Date(event.starts_at).getTime()}`,
          attachments,
        });
      }
    } catch (e) {
      // Письмо — не причина ронять создание встречи: она уже есть в системе и видна на экране.
      this.log.warn(`письма по событию ${event.id} не ушли: ${(e as Error).message}`);
    }
  }

  /** Напоминание: коротко и без вложения — встреча уже в календаре человека. */
  async sendReminder(r: {
    event_id: string; tenant_id: string; user_id: string; minutes_before: number;
    title: string; starts_at: Date; ends_at: Date; location: string | null; all_day: boolean; email: string;
    public_id?: string | null;
  }): Promise<void> {
    const meetUrl = this.meetUrl(r.public_id);
    const inWords = r.minutes_before >= 1440 ? `за ${Math.round(r.minutes_before / 1440)} дн.`
      : r.minutes_before >= 60 ? `за ${Math.round(r.minutes_before / 60)} ч`
        : `за ${r.minutes_before} мин`;
    await this.enqueue({
      tenantId: r.tenant_id,
      userId: r.user_id,
      toEmail: r.email,
      subject: `Скоро встреча: ${r.title}`,
      text: [
        `Напоминание ${inWords} до начала.`,
        '',
        r.title,
        this.when({ starts_at: r.starts_at, ends_at: r.ends_at, all_day: r.all_day }, await this.tzOf(String(r.tenant_id))),
        r.location ? `Место: ${r.location}` : '',
        '',
        meetUrl ? `Войти в созвон: ${meetUrl}` : `${this.baseUrl()}/focus/calendar`,
      ].join('\n'),
      eventKey: 'calendar.remind',
      dedupKey: `cal.remind:${r.event_id}:${r.user_id}:${r.minutes_before}:${new Date(r.starts_at).getTime()}`,
    });
  }

  private async enqueue(i: {
    tenantId: string; userId: string; toEmail: string; subject: string; text: string;
    eventKey: string; dedupKey: string; attachments?: { name: string; content: string }[];
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO mail_outbox (tenant_id, user_id, to_email, subject, body_text, body_html, event_key, dedup_key, attachments)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8) ON CONFLICT (dedup_key) DO NOTHING`,
      [i.tenantId, i.userId, i.toEmail, i.subject.slice(0, 255), i.text, i.eventKey,
        i.dedupKey.slice(0, 160), i.attachments ? JSON.stringify(i.attachments) : null],
    );
  }
}
