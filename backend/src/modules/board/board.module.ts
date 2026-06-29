import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TasksModule } from '../tasks/tasks.module';
import { BoardController } from './board.controller';
import { BoardService } from './board.service';

@Module({
  imports: [ProjectsModule, TasksModule],
  controllers: [BoardController],
  providers: [BoardService],
})
export class BoardModule {}
