import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { BrainController } from './brain.controller';
import { BrainService } from './brain.service';
import { BrainRepository } from './brain.repository';

@Module({
  imports: [KnowledgeModule],
  controllers: [BrainController],
  providers: [BrainService, BrainRepository],
})
export class BrainModule {}
