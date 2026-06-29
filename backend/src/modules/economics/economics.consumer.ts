import { Injectable, OnModuleInit } from '@nestjs/common';
import { Q_ECONOMICS, RabbitMQService } from '../../messaging/rabbitmq.service';
import { EconomicsProducer } from './economics.producer';
import { EconomicsService } from './economics.service';
import { EconomicsMessage } from './economics.types';

/** Консьюмер очереди economics. Полный пересчёт → идемпотентность. */
@Injectable()
export class EconomicsConsumer implements OnModuleInit {
  constructor(
    private readonly mq: RabbitMQService,
    private readonly service: EconomicsService,
    private readonly producer: EconomicsProducer,
  ) {}

  async onModuleInit() {
    await this.mq.consume(Q_ECONOMICS, async (msg: EconomicsMessage) => {
      await this.producer.clearPending(msg.dedupKey);
      await this.service.handle(msg);
    });
  }
}
