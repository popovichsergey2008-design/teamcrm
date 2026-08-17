import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { MailWorker } from './mail.worker';

/** Почтовые уведомления: постановка в очередь + отдельный отправляющий обработчик. */
@Module({
  imports: [DatabaseModule],
  controllers: [NotificationsController],
  providers: [NotificationsRepository, NotificationsService, MailWorker],
  exports: [NotificationsService],
})
export class NotificationsModule {}
