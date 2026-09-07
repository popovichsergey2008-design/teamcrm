import { Module } from '@nestjs/common';
import { IntegrationCryptoService } from '../crypto.service';
import { ImportRepository } from '../common/import.repository';
import { NotionController } from './notion.controller';
import { NotionService } from './notion.service';
import { NotionImportService } from './notion.import.service';

/**
 * Интеграция с Notion — слой 3 «переезда в один клик» (ТЗ-4).
 *
 * База данных со статусами → доска: свойство статуса становится колонками, страницы —
 * задачами, содержимое страницы — описанием, пункты списка дел — чек-листом.
 */
@Module({
  controllers: [NotionController],
  providers: [NotionService, NotionImportService, ImportRepository, IntegrationCryptoService],
})
export class NotionModule {}
