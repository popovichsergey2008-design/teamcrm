import { Module } from '@nestjs/common';
import { NavController } from './nav.controller';
import { NavService } from './nav.service';
import { TaskReadsModule } from '../tasks/task-reads.module';
import { NavRepository } from './nav.repository';
import { ApprovalsModule } from '../approvals/approvals.module';
import { CalendarModule } from '../calendar/calendar.module';
import { FeedModule } from '../feed/feed.module';

@Module({
  imports: [ApprovalsModule, CalendarModule, TaskReadsModule, FeedModule],
  controllers: [NavController],
  providers: [NavService, NavRepository],
  exports: [NavService],
})
export class NavModule {}
