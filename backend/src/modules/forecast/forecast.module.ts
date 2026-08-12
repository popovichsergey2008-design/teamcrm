import { Module } from '@nestjs/common';
import { VelocityModule } from '../velocity/velocity.module';
import { ForecastController } from './forecast.controller';
import { ForecastService } from './forecast.service';
import { ForecastRepository } from './forecast.repository';
import { IntegrationOutboxModule } from '../integrations/outbox/integration-outbox.module';

@Module({
  imports: [VelocityModule, IntegrationOutboxModule],
  controllers: [ForecastController],
  providers: [ForecastService, ForecastRepository],
  exports: [ForecastService, ForecastRepository],
})
export class ForecastModule {}
