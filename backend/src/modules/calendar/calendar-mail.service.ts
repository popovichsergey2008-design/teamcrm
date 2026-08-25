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
    return (this.config.get<string>('APP_BASE_URL') || 'https://teamsmrt.com').replace(/\/+$/, '');
  }

  private when(event: EventRow): string {
    if (event.all_day) {
      return new Date(event.starts_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + ', весь день';
    }
    const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' };
    const start = new Date(event.starts_at).toLocaleString('ru-RU', opts);
    const end = new Date(event.ends_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return `${start} — ${end}`;
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
        // номер правки растёт со временем изменения: без этого внешний календарь
        // считает письмо повтором и не обновляет встречу
        sequence: kind === 'cancel' ? 2 : 1,
        reminders,
      });
      const attachments = [{
        name: 'meeting.ics',
        content: Buffer.from(ics, 'utf8').toString('base64'),
      }];

      const url = `${this.baseUrl()}/focus/calendar`;
      const subject = kind === 'cancel' ? `Встреча отменена: ${event.title}` : `Встреча: ${event.title}`;
      for (const p of targets) {
        const lines = kind === 'cancel'
          ? [`Встреча «${event.title}» отменена.`, this.when(event)]
          : [
            `${organizer?.full_name ?? 'Коллега'} зовёт вас на встречу.`,
            '',
            event.title,
            this.when(event),
            event.location ? `Место: ${event.location}` : '',
            event.description ? '' : '',
            event.description ?? '',
            '',
            `Ответить и посмотреть подробности: ${url}`,
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
  }): Promise<void> {
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
        this.when({ starts_at: r.starts_at, ends_at: r.ends_at, all_day: r.all_day } as EventRow),
        r.location ? `Место: ${r.location}` : '',
        '',
        `${this.baseUrl()}/focus/calendar`,
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
