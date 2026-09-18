import { Global, Module } from '@nestjs/common';
import { AiGateway } from './ai-gateway';
import { AiService } from './ai.service';
import { AiSettingsService } from './ai-settings.service';
import { AiUsageController } from './ai-usage.controller';
import { IntegrationCryptoService } from '../integrations/crypto.service';

/** Global: AiService — единственная точка вызовов к LLM/Whisper. BYOK-ключи per-tenant. */
@Global()
@Module({
  controllers: [AiUsageController],
  providers: [AiService, AiSettingsService, IntegrationCryptoService, AiGateway],
  exports: [AiService, AiSettingsService, AiGateway],
})
export class AiModule {}
