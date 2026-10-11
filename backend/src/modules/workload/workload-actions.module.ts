import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { WorkloadActionsService } from './workload-actions.service';

@Module({ imports: [TasksModule], providers: [WorkloadActionsService] })
export class WorkloadActionsModule {}
