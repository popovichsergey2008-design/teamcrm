import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { HealthModule } from '../health/health.module';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { PcAuthController, PcController } from './pc.controller';
import { PcAuthService } from './pc-auth.service';
import { PcDevService } from './pc-dev.service';
import { PcGuard } from './pc.guard';
import { PcRepository } from './pc.repository';
import { PcStatsService } from './pc-stats.service';
import { PcSupportController } from './pc-support.controller';
import { PcSupportService } from './pc-support.service';
import { PlatformModule } from '../platform/platform.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SupportModule } from '../support/support.module';
import { MediaModule } from '../media/media.module';

/**
 * Консоли платформы (owner / developer / support.qevo.one). Чаты и уведомления CRM
 * консоль не получает: она не участник переписки. Служба заботы подключена только
 * ради консоли поддержки — оператор работает с обращениями её же методами (0223).
 */
@Module({
  imports: [JwtModule.register({}), AuthModule, HealthModule, PlatformModule, RealtimeModule, SupportModule, MediaModule],
  // PcSupportController — первым: его «support/presence» и «support/queue» не должны уйти в «support/:id»
  controllers: [PcAuthController, PcSupportController, PcController],
  providers: [PcRepository, PcAuthService, PcStatsService, PcDevService, PcSupportService, PcGuard, IntegrationCryptoService],
})
export class PconsoleModule {}
