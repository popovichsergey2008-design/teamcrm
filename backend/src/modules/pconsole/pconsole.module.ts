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

/**
 * Консоли платформы (owner / developer / support.qevo.one). Модуль намеренно не
 * импортирует чаты, уведомления и realtime CRM: консоль не участник переписки.
 */
@Module({
  imports: [JwtModule.register({}), AuthModule, HealthModule],
  controllers: [PcAuthController, PcController],
  providers: [PcRepository, PcAuthService, PcStatsService, PcDevService, PcGuard, IntegrationCryptoService],
})
export class PconsoleModule {}
