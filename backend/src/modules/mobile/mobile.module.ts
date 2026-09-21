import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MobileController } from './mobile.controller';
import { MobileService } from './mobile.service';
import { MobileDevicesRepository } from './mobile-devices.repository';

/** Мобильная инфраструктура (ТЗ-9): устройства; дальше — конфиг, ящик уведомлений, sync. */
@Module({
  imports: [AuthModule],
  controllers: [MobileController],
  providers: [MobileService, MobileDevicesRepository],
  exports: [MobileDevicesRepository],
})
export class MobileModule {}