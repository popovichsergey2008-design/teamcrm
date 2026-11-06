import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { TaskReadsModule } from '../tasks/task-reads.module';
import { TaskCardModule } from '../taskcard/taskcard.module';
import { UsersModule } from '../users/users.module';
import { FlowModule } from '../flow/flow.module';
import { BoardController } from './board.controller';
import { BoardService } from './board.service';

@Module({
  imports: [ProjectsModule, TasksModule, TaskCardModule, UsersModule, TaskReadsModule, FlowModule],
  controllers: [BoardController],
  providers: [BoardService],
  exports: [BoardService],
})
export class BoardModule {}
