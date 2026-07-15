import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { GdocsController } from './gdocs.controller';
import { GdocsService } from './gdocs.service';
import { GdocsRepository } from './gdocs.repository';

/** Сканирование Google-доков по ссылкам в задачах → индексация текста в базу знаний (RAG). */
@Module({
  imports: [KnowledgeModule],
  controllers: [GdocsController],
  providers: [GdocsService, GdocsRepository],
})
export class GdocsModule {}
