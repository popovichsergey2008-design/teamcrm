import { FocusModule } from '../focus/focus.module';
import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksModule } from '../tasks/tasks.module';
import { CommitmentsController } from './commitments.controller';
import { CommitmentsRepository } from './commitments.repository';
import { CommitmentsService } from './commitments.service';

/** Охотник за обещаниями (ТЗ-21, этап 2): навык проактивного секретаря. */
@Module({
  imports: [TasksModule, NotificationsModule, FocusModule],
  controllers: [CommitmentsController],
  providers: [CommitmentsService, CommitmentsRepository],
  exports: [CommitmentsService],
})
export class CommitmentsModule {}
