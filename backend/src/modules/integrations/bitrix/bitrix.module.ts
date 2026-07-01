import { Module } from '@nestjs/common';
import { IntegrationCryptoService } from '../crypto.service';
import { BitrixController } from './bitrix.controller';
import { BitrixService } from './bitrix.service';
import { BitrixImportService } from './bitrix.import.service';
import { BitrixRepository } from './bitrix.repository';

@Module({
  controllers: [BitrixController],
  providers: [BitrixService, BitrixImportService, BitrixRepository, IntegrationCryptoService],
})
export class BitrixModule {}
