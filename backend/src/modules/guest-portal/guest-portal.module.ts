import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { GuestHostController, GuestPublicController } from './guest-portal.controller';
import { GuestPortalRepository } from './guest-portal.repository';
import { GuestPortalService } from './guest-portal.service';

/** Гостевой портал (ТЗ-28): бренд, клиентский протокол встречи, ответы гостя. */
@Module({
  imports: [MediaModule, NotificationsModule],
  controllers: [GuestPublicController, GuestHostController],
  providers: [GuestPortalService, GuestPortalRepository, IntegrationCryptoService],
})
export class GuestPortalModule {}
