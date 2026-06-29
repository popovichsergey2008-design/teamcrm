import { Injectable } from '@nestjs/common';
import { RedisService } from '../../cache/redis.service';
import { Q_ECONOMICS, RabbitMQService } from '../../messaging/rabbitmq.service';
import { EconomicsMessage } from './economics.types';

/**
 * Постановка задач пересчёта в очередь `economics` с коалесингом:
 * частые обновления одной задачи схлопываются в одну due-обработку (Шаг 2.2).
 */
@Injectable()
export class EconomicsProducer {
  constructor(
    private readonly mq: RabbitMQService,
    private readonly redis: RedisService,
  ) {}

  async enqueue(msg: EconomicsMessage): Promise<void> {
    // коалесинг: SET NX — если ключ уже есть, такое сообщение уже в очереди
    const key = `econ:pending:${msg.dedupKey}`;
    const set = await this.redis.client.set(key, '1', 'EX', 30, 'NX').catch(() => 'OK');
    if (set !== 'OK') return; // уже запланировано
    await this.mq.publish(Q_ECONOMICS, msg);
  }

  /** Снимает пометку coalescing — вызывается консьюмером в начале обработки. */
  async clearPending(dedupKey: string): Promise<void> {
    await this.redis.del(`econ:pending:${dedupKey}`).catch(() => undefined);
  }
}
