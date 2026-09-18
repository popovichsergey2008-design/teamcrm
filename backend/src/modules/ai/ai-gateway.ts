import { Injectable, Logger } from '@nestjs/common';

/**
 * Очередь обращений к модели с приоритетами (05_SCALING §9–§11, §21).
 *
 * Модель — общий и узкий ресурс: обращений к ней десятки в минуту, а отвечает она
 * секундами. Без порядка живой разговор в поддержке стоит в одной очереди с фоновой
 * индексацией справочника — и человек ждёт, пока мы досчитаем то, чего никто не просил.
 *
 * Пять уровней, по убыванию срочности:
 *
 *   P0 incident      — авария: сообщения о массовом сбое;
 *   P1 support       — живой разговор в службе заботы;
 *   P2 user          — помощник, которого человек ждёт на экране;
 *   P3 background    — сводки, разборы встреч, ночные отчёты;
 *   P4 index         — индексация знаний.
 *
 * Ограничитель в памяти процесса, а не общий на кластер: цель — не распределить
 * квоту между машинами, а не дать фоновым задачам вытеснить живых людей внутри одного
 * приложения. Общий счётчик потребовал бы Redis на каждый вызов модели и добавил бы к
 * ответу человека ещё один сетевой поход.
 */

export type AiPriority = 'incident' | 'support' | 'user' | 'background' | 'index';

const ORDER: Record<AiPriority, number> = {
  incident: 0, support: 1, user: 2, background: 3, index: 4,
};

/**
 * Сколько запросов к модели идёт одновременно.
 *
 * Не «сколько выдержит модель», а «сколько имеет смысл»: дальше провайдер всё равно
 * ставит в очередь на своей стороне, только уже без нашего порядка приоритетов.
 */
const MAX_INFLIGHT = Number(process.env.AI_MAX_INFLIGHT ?? 6);

/**
 * По какому уровню сбрасываем нагрузку.
 *
 * При заторе фоновые задачи ждут своей минуты, а живые не ждут никогда: эскалация к
 * человеку и разговор в поддержке проходят всегда (§05.21).
 */
const SHED_AFTER = Number(process.env.AI_SHED_QUEUE ?? 40);

interface Waiter {
  priority: number;
  seq: number;
  run: () => void;
}

@Injectable()
export class AiGateway {
  private readonly log = new Logger('AiGateway');
  private inflight = 0;
  private seq = 0;
  private waiting: Waiter[] = [];
  /** Сколько раз отложили фоновую работу: видно в метриках, а не только в ощущениях. */
  private shed = 0;

  /**
   * Пропустить вызов модели через очередь.
   *
   * Живые запросы идут вперёд фоновых независимо от того, кто встал раньше: очередь
   * «кто пришёл, того и обслужили» на общем ресурсе означает, что человек ждёт ночной
   * отчёт.
   */
  async run<T>(priority: AiPriority, task: () => Promise<T>): Promise<T> {
    const weight = ORDER[priority] ?? ORDER.user;

    // Затор: фоновое подождёт следующего круга, живое — никогда.
    if (weight >= ORDER.background && this.waiting.length >= SHED_AFTER) {
      this.shed += 1;
      throw new Error('ai_busy');
    }

    if (this.inflight >= MAX_INFLIGHT) {
      await new Promise<void>((resolve) => {
        this.waiting.push({ priority: weight, seq: this.seq++, run: resolve });
        // Порядок: сначала важность, при равной важности — кто дольше ждёт.
        this.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      });
    }

    this.inflight += 1;
    try {
      return await task();
    } finally {
      this.inflight -= 1;
      const next = this.waiting.shift();
      if (next) next.run();
    }
  }

  /** Что происходит с очередью к модели — для метрик. */
  stats() {
    return { inflight: this.inflight, waiting: this.waiting.length, shed: this.shed };
  }
}
