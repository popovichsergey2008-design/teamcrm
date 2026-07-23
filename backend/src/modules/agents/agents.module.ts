import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { ProjectsModule } from '../projects/projects.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { TaskCardModule } from '../taskcard/taskcard.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentsRepository } from './agents.repository';
import { AgentPromptsService } from './agent-prompts.service';
import { AgentPromptsRepository } from './agent-prompts.repository';

/** Оркестрация ИИ-агентов: задача + база знаний (RAG) → выполнение (human-in-the-loop) + библиотека промптов. */
@Module({
  imports: [TasksModule, ProjectsModule, KnowledgeModule, TaskCardModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentsRepository, AgentPromptsService, AgentPromptsRepository],
})
export class AgentsModule {}
