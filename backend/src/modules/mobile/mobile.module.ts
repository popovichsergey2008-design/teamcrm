import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlatformModule } from '../platform/platform.module';
import { MobileConfigService } from './mobile-config.service';
import { MobileController } from './mobile.controller';
import { MobileService } from './mobile.service';
import { MobileDevicesRepository } from './mobile-devices.repository';

/** Мобильная инфраструктура (ТЗ-9): устройства; дальше — конфиг, ящик уведомлений, sync. */
@Module({
  imports: [AuthModule, NotificationsModule, PlatformModule],
  controllers: [MobileController],
  providers: [MobileService, MobileDevicesRepository, MobileConfigService],
  exports: [MobileDevicesRepository],
})
export class MobileModule {}