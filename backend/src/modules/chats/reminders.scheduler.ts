import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ChatsRepository } from './chats.repository';
import { RealtimeService } from '../realtime/realtime.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';

/**
 * Раз в минуту: напоминание, опоздавшее на десять минут, бесполезно — человек уже
 * либо вспомнил сам, либо забыл окончательно. Запрос дешёвый, под него есть индекс
 * ровно по «что уже пора».
 */
const TICK_MS = 60_000;

/**
 * Напоминания о сообщениях.
 *
 * Читают сообщения тогда, когда они пришли, а сделать по ним нужно позже — и держать
 * это в голове и есть та работа, которую система обязана снять с человека.
 *
 * Отправляем двумя путями сразу: во вкладку (всплывашка, если человек за компьютером)
 * и в Telegram (если нет). Одного канала мало: напоминание, которое пришло в закрытую
 * вкладку, не напомнило ни о чём.
 */
@Injectable()
export class RemindersScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MessageReminders');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly repo: ChatsRepository,
    private readonly realtime: RealtimeService,
    private readonly telegram: TelegramMirror,
  ) {}

  onModuleInit(): void {
    // unref: незавершённый таймер не должен держать процесс при остановке
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Проход: забрать созревшие, разослать, закрыть. Повторных срабатываний быть не должно. */
  async tick(): Promise<void> {
    if (this.busy) return; // предыдущий проход ещё идёт — второй только мешал бы
    this.busy = true;
    try {
      const due = await this.repo.dueReminders(new Date());
      if (!due.length) return;

      for (const r of due) {
        const text = String(r.body ?? '').slice(0, 160) || 'сообщение с вложением';
        this.realtime.emitToUsers(r.tenant_id, [r.user_id], 'chat.reminder', {
          chatId: String(r.chat_id),
          messageId: String(r.message_id),
          author: r.author_name,
          body: text,
        });
        // В Telegram — на случай закрытой вкладки. Не ушло (бот не привязан) — не беда,
        // всплывашка во вкладке остаётся основным каналом.
        void this.telegram.push(
          r.tenant_id, r.user_id,
          `Напоминание о сообщении${r.author_name ? ` от ${r.author_name}` : ''}:\n${text}`,
        ).catch(() => undefined);
      }
      // Закрываем ПОСЛЕ рассылки и все разом: упасть между отправками — значит
      // прислать одно и то же ещё раз через минуту.
      await this.repo.closeReminders(due.map((r) => String(r.id)));
      this.log.log(`напоминаний отправлено: ${due.length}`);
    } catch (e) {
      this.log.warn(`проход напоминаний не удался: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
