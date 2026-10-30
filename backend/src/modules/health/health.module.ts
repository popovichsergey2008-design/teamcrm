import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { CspReportController } from './csp-report.controller';
import { SystemNoticeController } from './system-notice.controller';

/** MediaModule — чтобы выкладка могла спросить, идёт ли сейчас созвон. */
@Module({
  imports: [MediaModule],
  controllers: [HealthController, CspReportController, SystemNoticeController],
  providers: [HealthService],
})
export class HealthModule {}
