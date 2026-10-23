import { Module } from '@nestjs/common';
import { VelocityModule } from '../velocity/velocity.module';
import { ForecastController } from './forecast.controller';
import { ForecastService } from './forecast.service';
import { ForecastRepository } from './forecast.repository';
import { IntegrationOutboxModule } from '../integrations/outbox/integration-outbox.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NotificationsModule — центр уведомлений: новый срок и исполнитель уходят в историю участникам (#4655)
  imports: [VelocityModule, IntegrationOutboxModule, NotificationsModule],
  controllers: [ForecastController],
  providers: [ForecastService, ForecastRepository],
  exports: [ForecastService, ForecastRepository],
})
export class ForecastModule {}
