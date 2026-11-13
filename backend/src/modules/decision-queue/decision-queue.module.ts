import { Module } from '@nestjs/common';
import { DecisionQueueRepository } from './decision-queue.repository';
import { DecisionQueueService } from './decision-queue.service';

/**
 * Очередь «ждут вашего решения» (#4890). Лёгкий модуль без зависимостей (только база):
 * его подключают Фокус, брифинг, меню, Пульс и бот — без колец импортов.
 */
@Module({
  providers: [DecisionQueueService, DecisionQueueRepository],
  exports: [DecisionQueueService],
})
export class DecisionQueueModule {}
