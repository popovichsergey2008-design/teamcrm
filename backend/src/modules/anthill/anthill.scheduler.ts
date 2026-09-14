import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AnthillService } from './anthill.service';
import { ChatsService } from '../chats/chats.service';
import { RealtimeService } from '../realtime/realtime.service';

/**
 * Раз в минуту: минутной точности расписанию хватает — «в 9:00» и «в 9:01»
 * человек не различает, а более частый опрос ничего не даёт: запрос смотрит в
 * частичный индекс по активным и обычно не находит ничего.
 */
const TICK_MS = 60_000;

/**
 * Регулярные задачи AnthillBot (ТЗ-6, разд. 15).
 *
 * «Каждый понедельник в 9:00 дай список просроченных» — это тот же вопрос агенту,
 * только задаёт его не человек, а календарь. Поэтому и выполняется он тем же
 * путём (`ask`), с правами того же человека: ничего, чего он не увидел бы сам,
 * в отчёт не попадёт.
 *
 * Результат ложится в свою нитку разговора И приходит сообщением в «Заметки»:
 * без второго человек узнает об отчёте, только когда сам откроет агента, — то
 * есть никогда. Ошибка тоже записывается: молчащая регулярная задача выглядит
 * так же, как работающая, и это самый неприятный вид поломки.
 */
@Injectable()
export class AnthillScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AnthillTasks');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly anthill: AnthillService,
    private readonly chats: ChatsService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    setTimeout(() => { void this.tick(); }, 15_000); // после перезапуска просроченное уже может ждать
    this.log.log(`регулярные задачи агента: планировщик запущен, проверка каждые ${TICK_MS / 1000} с`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = await this.anthill.scheduleDue();
      for (const row of due) {
        const started = Date.now();
        try {
          const { text, sessionId } = await this.anthill.runSchedule(row);
          await this.anthill.afterRun(row, text || 'Ответ пустой', null);
          await this.deliver(row, text, sessionId);
          this.log.log(`«${row.title}» для ${row.user_id}: готово за ${Math.round((Date.now() - started) / 1000)} с`);
        } catch (e) {
          const message = (e as Error).message;
          await this.anthill.afterRun(row, null, message.slice(0, 1000));
          this.log.warn(`«${row.title}» для ${row.user_id}: ${message}`);
        }
      }
    } catch (e) {
      this.log.warn(`проход не удался: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Куда приходит результат.
   *
   * В «Заметки» — потому что это личный чат человека: он уже есть на телефоне, в
   * уведомлениях и в Telegram-зеркале, и отчёт не нужно специально искать. Плюс
   * событие в сокет: если агент открыт, вкладка «Задачи» обновится сама.
   */
  private async deliver(row: { id: string; tenant_id: string; user_id: string; title: string; role: string }, text: string, sessionId: string): Promise<void> {
    const user = { userId: String(row.user_id), role: row.role };
    if (text) {
      const self = await this.chats.selfChat(String(row.tenant_id), user);
      const body = `🐜 ${row.title}\n\n${text.slice(0, 3500)}`;
      await this.chats.send(String(row.tenant_id), String(self.id), user, body, null).catch(() => undefined);
    }
    this.realtime.emitToUsers(String(row.tenant_id), [String(row.user_id)], 'anthill.task.done', {
      id: String(row.id), title: row.title, sessionId,
    });
  }
}
