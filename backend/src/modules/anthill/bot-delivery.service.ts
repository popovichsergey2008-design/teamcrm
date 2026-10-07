import { Injectable } from '@nestjs/common';
import { PushService } from '../notifications/push.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';

/**
 * Как секретарь достаёт человека (ТЗ-18, этап 4).
 *
 * Одна дверь на все личные сообщения бота: напоминание, отчёт регулярной задачи,
 * её сбой, сводка. В ящик и push — через PushService.personal, в Telegram — тем же
 * каналом, что дубли писем, со своей настройкой человека.
 *
 * Раньше бот писал в «Заметки» от имени самого человека — а свои сообщения не дают
 * ни push, ни Telegram, и напоминание приходило молча. Отсюда и эта дверь.
 */
@Injectable()
export class BotDelivery {
  constructor(private readonly push: PushService, private readonly telegram: TelegramMirror) {}

  async send(
    tenantId: string, userId: string,
    m: { eventKey: string; title: string; body: string; path?: string; channels?: { push?: boolean; telegram?: boolean } },
  ): Promise<void> {
    const path = m.path ?? '/chat/anthill';
    // в ящик — всегда; push и Telegram — если человек не выключил их для сводок
    await this.push.personal({
      tenantId, userId, eventKey: m.eventKey, title: m.title, body: m.body.slice(0, 1000), path,
      push: m.channels?.push !== false,
    });
    if (m.channels?.telegram === false) return;
    const text = m.body.trim() ? `${m.title}\n\n${m.body.slice(0, 3500)}` : m.title;
    await this.telegram.push(tenantId, userId, text).catch(() => false);
  }
}
