import { Module } from '@nestjs/common';
import { IntegrationCryptoService } from '../crypto.service';
import { YougileController } from './yougile.controller';
import { YougileEventsController } from './yougile-events.controller';
import { YougileService } from './yougile.service';
import { YougileImportService } from './yougile.import.service';
import { YougileRepository } from './yougile.repository';
import { YougileOutboundService } from './yougile.outbound.service';

/**
 * Интеграция с YouGile: E1 импорт, E2 комменты/вложения, E3 живая синхронизация (вебхуки),
 * E4 обратная выгрузка изменений CRM → YouGile (очередь integration_outbox).
 */
@Module({
  controllers: [YougileController, YougileEventsController],
  providers: [YougileService, YougileImportService, YougileRepository, IntegrationCryptoService, YougileOutboundService],
})
export class YougileModule {}
