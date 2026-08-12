import { Module } from '@nestjs/common';
import { IntegrationOutboxService } from './integration-outbox.service';

/** Очередь исходящих изменений CRM → внешние системы (постановка). Отправку делает модуль провайдера. */
@Module({
  providers: [IntegrationOutboxService],
  exports: [IntegrationOutboxService],
})
export class IntegrationOutboxModule {}
