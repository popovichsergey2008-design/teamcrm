import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { BrainController } from './brain.controller';
import { BrainService } from './brain.service';
import { BrainRepository } from './brain.repository';

@Module({
  imports: [KnowledgeModule],
  controllers: [BrainController],
  providers: [BrainService, BrainRepository],
  // Инфоцентр проекта (#4659) спрашивает тот же мозг в рамках проекта
  exports: [BrainService],
})
export class BrainModule {}
