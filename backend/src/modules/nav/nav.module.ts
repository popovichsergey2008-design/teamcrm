import { Module } from '@nestjs/common';
import { NavController } from './nav.controller';
import { NavService } from './nav.service';
import { NavRepository } from './nav.repository';

@Module({
  controllers: [NavController],
  providers: [NavService, NavRepository],
  exports: [NavService],
})
export class NavModule {}
