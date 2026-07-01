import { Module } from '@nestjs/common';
import { IntegrationCryptoService } from '../crypto.service';
import { BitrixController } from './bitrix.controller';
import { BitrixEventsController } from './bitrix-events.controller';
import { BitrixService } from './bitrix.service';
import { BitrixImportService } from './bitrix.import.service';
import { BitrixRepository } from './bitrix.repository';

@Module({
  controllers: [BitrixController, BitrixEventsController],
  providers: [BitrixService, BitrixImportService, BitrixRepository, IntegrationCryptoService],
})
export class BitrixModule {}
