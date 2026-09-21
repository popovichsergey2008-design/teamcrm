import { Injectable, Logger } from '@nestjs/common';
import { FcmSender } from './fcm.sender';
import { InboxRepository, InboxRow } from './inbox.repository';
import { MailRow } from './notifications.repository';

/**
 * Ящик + push для каждого письма из очереди (ТЗ-9, волна 4).
 *
 * Зовётся воркером до отправки письма, как и дубль в Telegram: событие обязано лечь
 * в ящик независимо от судьбы письма. Push — сигнал «есть новое», а не носитель
 * события: телефон, проснувшись, догоняет ящик по курсору.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger('Push');

  constructor(private readonly inbox: InboxRepository, private readonly fcm: FcmSender) {}

  /** Путь внутри приложения из первой ссылки на наш домен в письме. */
  static pathOf(text: string): string | null {
    const base = (process.env.APP_BASE_URL || 'https://anthill.team').replace(/\/+$/, '');
    const m = new RegExp(`${base.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(/[^\\s)>"']*)`).exec(text ?? '');
    if (!m) return null;
    // ссылки на API (отписка) — не маршрут приложения
    return m[1].startsWith('/api/') ? null : m[1];
  }

  /** Первый абзац письма без ссылок — то, что уместно показать на экране блокировки. */
  static previewOf(text: string): string {
    return String(text ?? '')
      .split(/\n\s*\n/)[0]
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }

  async deliver(row: MailRow): Promise<void> {
    if (!row.user_id) return;
    let item: InboxRow | null = null;
    try {
      item = await this.inbox.record({
        tenantId: row.tenant_id, userId: row.user_id, mailId: String(row.id), eventKey: row.event_key,
        title: row.subject, body: PushService.previewOf(row.body_text), path: PushService.pathOf(row.body_text),
      });
    } catch (e) {
      this.log.warn(`ящик для письма #${row.id}: ${(e as Error).message}`);
      return;
    }
    if (!item || row.push_sent_at || !this.fcm.enabled) return;

    try {
      const targets = await this.inbox.pushTargets(row.user_id);
      if (!targets.length) return;
      const privacy = await this.inbox.pushPrivacyOf(row.tenant_id);
      const badge = await this.inbox.unreadCount(row.user_id);
      /*
        Что видно на экране блокировки — по политике организации (D-07).
        sender_only: заголовок письма (в нём «кто и что»), без текста; hide — только
        факт; full — как есть.
      */
      const title = privacy === 'hide' ? 'ANTHILL' : item.title;
      const body = privacy === 'full' ? item.body : privacy === 'sender_only' ? 'Откройте, чтобы прочитать' : 'Есть новое';
      for (const t of targets) {
        const outcome = await this.fcm.send(t.push_token, {
          title, body, badge,
          data: { path: item.path ?? '', inboxId: String(item.id), eventKey: item.event_key },
        });
        if (outcome === 'invalid_token') await this.inbox.dropPushToken(t.id);
      }
      await this.inbox.markPushSent(String(row.id));
    } catch (e) {
      this.log.warn(`push для письма #${row.id}: ${(e as Error).message}`);
    }
  }
}