import { Injectable, OnModuleInit } from '@nestjs/common';
import { Q_AI_STANDUP, RabbitMQService } from '../../messaging/rabbitmq.service';
import { StandupService } from './standup.service';
import { StandupMessage } from './standup.types';

/** Консьюмер очереди ai_standup. Идемпотентные переходы машины состояний. */
@Injectable()
export class StandupConsumer implements OnModuleInit {
  constructor(
    private readonly mq: RabbitMQService,
    private readonly service: StandupService,
  ) {}

  async onModuleInit() {
    await this.mq.consume(Q_AI_STANDUP, (msg: StandupMessage) => this.service.handle(msg), 2);
  }
}
