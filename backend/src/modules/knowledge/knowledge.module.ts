import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { FilesModule } from '../files/files.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeRepository } from './knowledge.repository';
import { RegulationsService } from './regulations.service';
import { HandbookService } from './handbook.service';
import { MemoryIndexer } from './memory-indexer.service';

@Module({
  imports: [AiModule, FilesModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeRepository, RegulationsService, HandbookService, MemoryIndexer],
  exports: [KnowledgeService, HandbookService, MemoryIndexer],
})
export class KnowledgeModule {}
