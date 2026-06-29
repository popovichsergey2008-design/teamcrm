import { Module } from '@nestjs/common';
import { EconomicsModule } from '../economics/economics.module';
import { RatesController } from './rates.controller';
import { RatesRepository } from './rates.repository';

@Module({
  imports: [EconomicsModule],
  controllers: [RatesController],
  providers: [RatesRepository],
})
export class RatesModule {}
