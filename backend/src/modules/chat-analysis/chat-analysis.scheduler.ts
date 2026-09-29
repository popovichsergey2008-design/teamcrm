import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ChatAnalysisService } from './chat-analysis.service';

/**
 * Раз в пять минут ищем затихшие разговоры.
 *
 * Чаще незачем: самая короткая допустимая тишина — пять минут, и разговор, затихший
 * минуту назад, всё равно ещё не разговор. Реже — и разбор отстаёт от рабочего дня.
 */
const TICK_MS = 5 * 60_000;

@Injectable()
export class ChatAnalysisScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ChatAnalysisTick');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly svc: ChatAnalysisService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // unref: незавершённый таймер не должен держать процесс при остановке
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Проходы не накладываются: разбор ходит к модели и бывает долгим. */
  async tick(now = new Date()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const n = await this.svc.tick(now);
      if (n) this.log.log(`разобрано разговоров: ${n}`);
      // Суточная сверка — в том же проходе: сама решает, наступил ли час у организации.
      const d = await this.svc.daily(now);
      if (d) this.log.log(`суточная сверка: организаций ${d}`);
      return n;
    } catch (e) {
      this.log.error(`проход не удался: ${(e as Error).message}`);
      return 0;
    } finally {
      this.busy = false;
    }
  }
}
