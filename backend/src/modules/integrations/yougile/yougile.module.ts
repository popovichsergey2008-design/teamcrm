import { Module } from '@nestjs/common';
import { IntegrationCryptoService } from '../crypto.service';
import { YougileController } from './yougile.controller';
import { YougileService } from './yougile.service';
import { YougileImportService } from './yougile.import.service';
import { YougileRepository } from './yougile.repository';

/** Интеграция с YouGile (E1: импорт досок/колонок/задач). Общие таблицы integration_connections/external_refs/import_runs. */
@Module({
  controllers: [YougileController],
  providers: [YougileService, YougileImportService, YougileRepository, IntegrationCryptoService],
})
export class YougileModule {}
