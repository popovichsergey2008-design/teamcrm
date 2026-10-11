import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProactiveController } from './proactive.controller';
import { ProactiveRepository } from './proactive.repository';
import { ProactiveScheduler } from './proactive.scheduler';
import { ProactiveService } from './proactive.service';

/**
 * Проактивный секретарь (ТЗ-21): ящик предложений и планировщик навыков.
 * Глобальный: навыки живут в своих модулях (разбор переписки, встречи, задачи) и кладут
 * предложения сюда без встречных импортов.
 */
@Global()
@Module({
  imports: [NotificationsModule],
  controllers: [ProactiveController],
  providers: [ProactiveService, ProactiveRepository, ProactiveScheduler],
  exports: [ProactiveService, ProactiveScheduler, ProactiveRepository],
})
export class ProactiveModule {}
