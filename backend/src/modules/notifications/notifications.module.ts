import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { MailWorker } from './mail.worker';
import { TelegramMirror } from './telegram-mirror.service';
import { TelegramModule } from '../telegram/telegram.module';
import { InboxRepository } from './inbox.repository';
import { FcmSender } from './fcm.sender';
import { PushService } from './push.service';

/** Почтовые уведомления: постановка в очередь + отдельный отправляющий обработчик. */
@Module({
  imports: [DatabaseModule, TelegramModule],
  controllers: [NotificationsController],
  providers: [NotificationsRepository, NotificationsService, MailWorker, TelegramMirror, InboxRepository, FcmSender, PushService],
  exports: [NotificationsService, TelegramMirror, InboxRepository, PushService],
})
export class NotificationsModule {}
