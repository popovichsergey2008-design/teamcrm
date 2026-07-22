import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { TaskCardModule } from '../taskcard/taskcard.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentsRepository } from './agents.repository';

/** Оркестрация ИИ-агентов: задача + база знаний (RAG) → черновик решения в комментарий (human-in-the-loop). */
@Module({
  imports: [TasksModule, KnowledgeModule, TaskCardModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentsRepository],
})
export class AgentsModule {}
