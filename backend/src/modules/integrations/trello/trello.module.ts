import { Module } from '@nestjs/common';
import { IntegrationCryptoService } from '../crypto.service';
import { TrelloController } from './trello.controller';
import { TrelloService } from './trello.service';
import { TrelloImportService } from './trello.import.service';
import { TrelloRepository } from './trello.repository';

/**
 * Интеграция с Trello — слой 2 «переезда в один клик» (ТЗ-4).
 *
 * Живёт на общих таблицах интеграций (integration_connections, external_refs,
 * import_runs) вместе с Битриксом и YouGile: третья пара своих таблиц превратила бы
 * историю прогонов в три разные истории.
 */
@Module({
  controllers: [TrelloController],
  providers: [TrelloService, TrelloImportService, TrelloRepository, IntegrationCryptoService],
})
export class TrelloModule {}
