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
import { CenterRepository } from './center.repository';
import { NotificationCenter } from './center.service';
import { NotificationCenterController } from './center.controller';

/** Почтовые уведомления: постановка в очередь + отдельный отправляющий обработчик; центр уведомлений (#4655). */
@Module({
  imports: [DatabaseModule, TelegramModule],
  controllers: [NotificationsController, NotificationCenterController],
  providers: [NotificationsRepository, NotificationsService, MailWorker, TelegramMirror, InboxRepository, FcmSender, PushService,
    CenterRepository, NotificationCenter],
  exports: [NotificationsService, TelegramMirror, InboxRepository, PushService, NotificationCenter],
})
export class NotificationsModule {}
