import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../cache/redis.service';
import { RealtimeService } from '../realtime/realtime.service';
import { FcmSender } from './fcm.sender';
import { InboxRepository, InboxRow } from './inbox.repository';
import { MailRow } from './notifications.repository';

/** Сообщение чата для push: кому, откуда, что показать (ТЗ-9, волна 6). */
export interface ChatPushInput {
  tenantId: string;
  chatId: string;
  /** dm | group | channel | project | task */
  chatKind: string;
  chatTitle: string | null;
  authorId: string;
  authorName: string | null;
  text: string;
  /** Все получатели сообщения (без автора отфильтруем сами). */
  recipients: string[];
  /** Кого упомянули: им шлём и при режиме «только упоминания». */
  mentioned: string[];
  /** Режимы уведомлений участников: all | mentions | none (нет строки — all). */
  modes: { user_id: string; notify: string }[];
  /** Ветка — в путь, чтобы открыть её сразу. */
  threadRootId?: string | null;
}

/** Не чаще одного push по одному чату одному человеку за это время — иначе оживлённая группа шлёт очередь. */
const CHAT_PUSH_THROTTLE_S = 120;

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

  constructor(
    private readonly inbox: InboxRepository,
    private readonly fcm: FcmSender,
    private readonly realtime: RealtimeService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Сообщение чата → тем, кого нет в сети (ТЗ-9, волна 6).
   *
   * Письмами чаты не ходят (это был бы спам), поэтому сюда — напрямую, минуя очередь.
   * Правила: автору не шлём; кто сейчас в приложении — видит сообщение сам; режим
   * «только упоминания» уважаем; «выключено» — молчим; по одному чату одному человеку
   * — не чаще раза в две минуты (дедуп в Redis), чтобы живая группа не заваливала
   * телефон. Запись в ящик — всегда (без письма, mail_id пуст): по курсору телефон
   * увидит её, даже если push сглотнули.
   */
  async chatMessage(m: ChatPushInput): Promise<void> {
    try {
      const privacy = await this.inbox.pushPrivacyOf(m.tenantId);
      const modes = new Map(m.modes.map((x) => [String(x.user_id), x.notify]));
      const mentioned = new Set(m.mentioned.map(String));
      const path = m.threadRootId ? `/chat/${m.chatId}/thread/${m.threadRootId}` : `/chat/${m.chatId}`;
      const isDm = m.chatKind === 'dm';
      const who = m.authorName ?? 'Сообщение';
      const where = isDm ? who : `${m.chatTitle ?? 'Чат'} · ${who}`;
      for (const userId of new Set(m.recipients.map(String))) {
        if (userId === String(m.authorId)) continue;
        const mode = modes.get(userId) ?? 'all';
        if (mode === 'none') continue;
        if (mode === 'mentions' && !mentioned.has(userId)) continue;
        if (this.realtime.isOnline(m.tenantId, userId)) continue;

        const item = await this.inbox.record({
          tenantId: m.tenantId, userId, mailId: null, eventKey: mentioned.has(userId) ? 'chat.mention' : 'chat.message',
          title: where, body: PushService.previewOf(m.text), path,
        });
        if (!item || !this.fcm.enabled) continue;
        if (!(await this.allowChatPush(userId, m.chatId))) continue;

        const targets = await this.inbox.pushTargets(userId);
        if (!targets.length) continue;
        const badge = await this.inbox.unreadCount(userId);
        const title = privacy === 'hide' ? 'ANTHILL' : where;
        const body = privacy === 'full' ? item.body : privacy === 'sender_only' ? 'Новое сообщение' : 'Есть новое';
        for (const t of targets) {
          const outcome = await this.fcm.send(t.push_token, {
            title, body, badge, data: { path, inboxId: String(item.id), eventKey: item.event_key, chatId: m.chatId },
          });
          if (outcome === 'invalid_token') await this.inbox.dropPushToken(t.id);
        }
      }
    } catch (e) {
      this.log.warn(`push по чату ${m.chatId}: ${(e as Error).message}`);
    }
  }

  /**
   * Входящий звонок (ТЗ-9, волна 7): push с высоким приоритетом всем устройствам человека.
   *
   * В ящик не пишем — звонок не новость, а событие на минуту: пропущенный виден в
   * митах. Один push на звонок на человека (дедуп в Redis на минуту): звонящий может
   * дёргать приглашение несколько раз, телефон должен зазвонить один раз.
   * Что видно на экране блокировки — по политике организации: имя звонящего или
   * просто «Входящий звонок».
   */
  async callInvite(m: { tenantId: string; userId: string; meetingId: string; callerName: string }): Promise<void> {
    if (!this.fcm.enabled) return;
    try {
      const targets = await this.inbox.pushTargets(m.userId);
      if (!targets.length) return;
      try {
        const r = await this.redis.client.set(`push:call:${m.userId}:${m.meetingId}`, '1', 'EX', 60, 'NX');
        if (r !== 'OK') return;
      } catch { /* без Redis — шлём */ }
      const privacy = await this.inbox.pushPrivacyOf(m.tenantId);
      const title = privacy === 'hide' ? 'ANTHILL' : `Входящий звонок · ${m.callerName}`;
      const body = privacy === 'hide' ? 'Входящий звонок' : 'Откройте, чтобы ответить';
      for (const t of targets) {
        const outcome = await this.fcm.send(t.push_token, {
          title, body, data: { type: 'call', meetingId: m.meetingId, path: '/chat', eventKey: 'meet.incoming-call' },
        });
        if (outcome === 'invalid_token') await this.inbox.dropPushToken(t.id);
      }
    } catch (e) {
      this.log.warn(`push о звонке ${m.meetingId}: ${(e as Error).message}`);
    }
  }

  /**
   * Служба заботы (ТЗ-9, волна 10): человеку, который написал в поддержку и ушёл.
   *
   * Разговор с поддержкой не чат: ответ приходит через минуты или часы, и человек
   * к этому моменту закрыл приложение. Без push он узнаёт об ответе, когда сам
   * вспомнит. Шлём то, что требует его внимания: ответ, «подключился специалист»,
   * предложение созвона, «проверьте, всё работает?» и «мы выпустили исправление».
   * Кто сейчас в приложении — видит панель сам. Ответы подряд — один push на минуту
   * по разговору (дедуп в Redis); звонок и починка идут всегда. В ящик — всегда.
   */
  async supportEvent(m: {
    tenantId: string; userId: string; conversationId: string;
    kind: 'reply' | 'agent_joined' | 'call' | 'resolved' | 'fix';
    title: string; body: string;
  }): Promise<void> {
    try {
      if (this.realtime.isOnline(m.tenantId, m.userId)) return;
      const path = `/support/${m.conversationId}`;
      const item = await this.inbox.record({
        tenantId: m.tenantId, userId: m.userId, mailId: null, eventKey: `support.${m.kind}`,
        title: m.title, body: m.body, path,
      });
      if (!item || !this.fcm.enabled) return;
      if (m.kind === 'reply' || m.kind === 'agent_joined') {
        try {
          const r = await this.redis.client.set(`push:support:${m.userId}:${m.conversationId}`, '1', 'EX', 60, 'NX');
          if (r !== 'OK') return;
        } catch { /* без Redis — шлём */ }
      }
      const targets = await this.inbox.pushTargets(m.userId);
      if (!targets.length) return;
      const badge = await this.inbox.unreadCount(m.userId);
      const privacy = await this.inbox.pushPrivacyOf(m.tenantId);
      const title = privacy === 'hide' ? 'ANTHILL' : m.title;
      const body = privacy === 'full' ? m.body : 'Служба заботы: есть новое';
      for (const t of targets) {
        const outcome = await this.fcm.send(t.push_token, {
          title, body, badge,
          data: { type: 'support', path, inboxId: String(item.id), eventKey: item.event_key, conversationId: m.conversationId },
        });
        if (outcome === 'invalid_token') await this.inbox.dropPushToken(t.id);
      }
    } catch (e) {
      this.log.warn(`push по обращению ${m.conversationId}: ${(e as Error).message}`);
    }
  }

  private async allowChatPush(userId: string, chatId: string): Promise<boolean> {
    try {
      const r = await this.redis.client.set(`push:chat:${userId}:${chatId}`, '1', 'EX', CHAT_PUSH_THROTTLE_S, 'NX');
      return r === 'OK';
    } catch { return true; }
  }

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
    // Живому приложению (сокет открыт, пусть и в фоне) — сигнал без push: оно само догонит ящик (волна 12).
    if (item) this.realtime.emitToUsers(row.tenant_id, [row.user_id], 'inbox.item', { id: String(item.id), eventKey: item.event_key });
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