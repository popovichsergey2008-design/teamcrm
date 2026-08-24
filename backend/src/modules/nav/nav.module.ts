import { Module } from '@nestjs/common';
import { NavController } from './nav.controller';
import { NavService } from './nav.service';
import { NavRepository } from './nav.repository';
import { ApprovalsModule } from '../approvals/approvals.module';

@Module({
  imports: [ApprovalsModule],
  controllers: [NavController],
  providers: [NavService, NavRepository],
  exports: [NavService],
})
export class NavModule {}
