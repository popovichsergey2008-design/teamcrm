import { Module } from '@nestjs/common';
import { IntegrationCryptoService } from '../crypto.service';
import { YougileController } from './yougile.controller';
import { YougileEventsController } from './yougile-events.controller';
import { YougileService } from './yougile.service';
import { YougileImportService } from './yougile.import.service';
import { YougileRepository } from './yougile.repository';

/** Интеграция с YouGile: E1 импорт, E2 комменты/вложения, E3 живая синхронизация (вебхуки). */
@Module({
  controllers: [YougileController, YougileEventsController],
  providers: [YougileService, YougileImportService, YougileRepository, IntegrationCryptoService],
})
export class YougileModule {}
