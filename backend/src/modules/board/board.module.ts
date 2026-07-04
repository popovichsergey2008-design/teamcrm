import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { TaskCardModule } from '../taskcard/taskcard.module';
import { UsersModule } from '../users/users.module';
import { BoardController } from './board.controller';
import { BoardService } from './board.service';

@Module({
  imports: [ProjectsModule, TasksModule, TaskCardModule, UsersModule],
  controllers: [BoardController],
  providers: [BoardService],
  exports: [BoardService],
})
export class BoardModule {}
