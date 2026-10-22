import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { WorkloadActionsService } from './workload-actions.service';
import { WorkloadController } from './workload.controller';

@Module({ imports: [TasksModule], controllers: [WorkloadController], providers: [WorkloadActionsService] })
export class WorkloadActionsModule {}
