import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { CspReportController } from './csp-report.controller';

/** MediaModule — чтобы выкладка могла спросить, идёт ли сейчас созвон. */
@Module({
  imports: [MediaModule],
  controllers: [HealthController, CspReportController],
  providers: [HealthService],
})
export class HealthModule {}
