import { Module } from '@nestjs/common';
import { EconomicsController } from './economics.controller';
import { EconomicsService } from './economics.service';
import { EconomicsRepository } from './economics.repository';
import { EconomicsProducer } from './economics.producer';
import { EconomicsConsumer } from './economics.consumer';
import { EconomicsScheduler } from './economics.scheduler';

@Module({
  controllers: [EconomicsController],
  providers: [
    EconomicsService,
    EconomicsRepository,
    EconomicsProducer,
    EconomicsConsumer,
    EconomicsScheduler,
  ],
  exports: [EconomicsService, EconomicsProducer],
})
export class EconomicsModule {}
