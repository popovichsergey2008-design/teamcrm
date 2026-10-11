import { Global, Module } from '@nestjs/common';
import { PulseRepository } from '../radar/pulse.repository';
import { WorkloadGuardService } from './workload.service';

/**
 * Страж нагрузки (ТЗ-21, этап 3). Глобальный и без зависимостей от задач: его вызывают
 * задачи, быстрая команда, бот — а кнопки карточки живут в WorkloadActionsModule.
 */
@Global()
@Module({
  providers: [WorkloadGuardService, PulseRepository],
  exports: [WorkloadGuardService],
})
export class WorkloadModule {}
