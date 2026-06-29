import { Module } from '@nestjs/common';
import { DealsController } from './deals.controller';
import { DealsService } from './deals.service';
import { DealsRepository } from './deals.repository';

@Module({
  controllers: [DealsController],
  providers: [DealsService, DealsRepository],
  exports: [DealsService, DealsRepository],
})
export class DealsModule {}
