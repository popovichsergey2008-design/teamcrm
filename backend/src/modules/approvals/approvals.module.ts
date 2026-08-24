import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { ApprovalsRepository } from './approvals.repository';

@Module({
  controllers: [ApprovalsController],
  providers: [ApprovalsService, ApprovalsRepository],
  exports: [ApprovalsRepository], // счётчик бейджа читает модуль навигации
})
export class ApprovalsModule {}
