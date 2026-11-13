import { Module } from '@nestjs/common';
import { NavController } from './nav.controller';
import { NavService } from './nav.service';
import { TaskReadsModule } from '../tasks/task-reads.module';
import { NavRepository } from './nav.repository';
import { ApprovalsModule } from '../approvals/approvals.module';
import { CalendarModule } from '../calendar/calendar.module';
import { FeedModule } from '../feed/feed.module';
import { DecisionQueueModule } from '../decision-queue/decision-queue.module';

@Module({
  imports: [ApprovalsModule, CalendarModule, TaskReadsModule, FeedModule, DecisionQueueModule],
  controllers: [NavController],
  providers: [NavService, NavRepository],
  exports: [NavService],
})
export class NavModule {}
