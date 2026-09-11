import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ChatsService } from './chats.service';
import { ScheduledRepository } from './scheduled.repository';

/**
 * Раз в полминуты.
 *
 * Отложенное сообщение — это обещание времени: «напомни за полчаса до встречи»
 * бессмысленно, если придёт через пять минут после. Запрос дешёвый: частичный
 * индекс по ожидающим строкам, обычно ноль результатов.
 */
const TICK_MS = 30_000;

/**
 * Отправка отложенных сообщений.
 *
 * Сообщение уходит ОБЫЧНЫМ путём (`chats.send`), а не вставкой в таблицу: иначе
 * оно не разбудит собеседника, не попадёт в упоминания и не покажется в ленте —
 * то есть будет сообщением второго сорта, о котором никто не узнает.
 *
 * Права проверяются в момент отправки, а не в момент планирования: за час человека
 * могли убрать из группы, и отправлять «от его имени» в чат, куда он больше не
 * входит, нельзя. Такая неудача записывается в строку, а не теряется молча.
 */
@Injectable()
export class ScheduledMessagesScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ChatScheduled');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly repo: ScheduledRepository,
    private readonly chats: ChatsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    // Первый проход сразу: после перезапуска в очереди уже может быть просроченное.
    setTimeout(() => { void this.tick(); }, 5_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return; // прошлый проход ещё идёт — второй не начинаем
    this.busy = true;
    try {
      const due = await this.repo.dueBatch();
      for (const row of due) {
        try {
          const message = await this.chats.send(
            String(row.tenant_id), String(row.chat_id),
            // Роль берём рядовую: отложенное сообщение не даёт прав, которых не было.
            { userId: String(row.author_id), role: 'member' },
            row.body, null,
            { rootId: row.thread_root_id ? String(row.thread_root_id) : null, alsoInChannel: row.also_in_channel },
            (row.mention_ids ?? []).map(String),
          );
          await this.repo.markSent(String(row.id), String((message as { id?: string })?.id ?? ''));
        } catch (e) {
          await this.repo.markFailed(String(row.id), (e as Error).message);
          this.log.warn(`отложенное ${row.id} не ушло: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.warn(`проход отложенных: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
