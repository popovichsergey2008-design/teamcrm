import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/** MediaModule — чтобы выкладка могла спросить, идёт ли сейчас созвон. */
@Module({
  imports: [MediaModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
