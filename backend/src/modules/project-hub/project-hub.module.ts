import { Module } from '@nestjs/common';
import { BrainModule } from '../brain/brain.module';
import { ClientsModule } from '../clients/clients.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { ProjectsModule } from '../projects/projects.module';
import { HubLibrarianScheduler } from './hub-librarian.scheduler';
import { HubLibrarianService } from './hub-librarian.service';
import { ProjectHubController } from './project-hub.controller';
import { ProjectHubRepository } from './project-hub.repository';
import { ProjectHubService } from './project-hub.service';

/** Инфоцентр проекта и ИИ-библиотекарь (#4659). ИИ, тарифы, промпты, реалтайм — глобальные. */
@Module({
  imports: [ProjectsModule, ClientsModule, KnowledgeModule, BrainModule],
  controllers: [ProjectHubController],
  providers: [ProjectHubRepository, ProjectHubService, HubLibrarianService, HubLibrarianScheduler],
  exports: [ProjectHubService, HubLibrarianService],
})
export class ProjectHubModule {}
