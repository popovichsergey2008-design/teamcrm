import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReportsModule } from '../reports/reports.module';
import { BeforeAfterController } from './before-after.controller';
import { BeforeAfterRepository } from './before-after.repository';
import { BeforeAfterService } from './before-after.service';
import { PageShooter } from './page-shot';

/**
 * Отчёт «было/стало» (#4657). Глобальный: автозапуск зовут задачи при сдаче, а
 * встречной зависимости от задач у модуля нет — материалы он читает сам.
 */
@Global()
@Module({
  imports: [NotificationsModule, ReportsModule],
  controllers: [BeforeAfterController],
  providers: [BeforeAfterService, BeforeAfterRepository, PageShooter],
  exports: [BeforeAfterService],
})
export class BeforeAfterModule {}
