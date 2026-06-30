import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { TaskCardModule } from '../taskcard/taskcard.module';
import { BoardController } from './board.controller';
import { BoardService } from './board.service';

@Module({
  imports: [ProjectsModule, TasksModule, TaskCardModule],
  controllers: [BoardController],
  providers: [BoardService],
})
export class BoardModule {}
