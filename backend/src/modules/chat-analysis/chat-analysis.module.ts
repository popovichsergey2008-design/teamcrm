import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { PromptsModule } from '../prompts/prompts.module';
import { ChatAnalysisController } from './chat-analysis.controller';
import { ChatAnalysisRepository } from './chat-analysis.repository';
import { ChatAnalysisScheduler } from './chat-analysis.scheduler';
import { ChatAnalysisService } from './chat-analysis.service';

/**
 * Разбор переписки (ТЗ-12). Первый этап: агент читает затихшие разговоры и показывает,
 * что понял. Ничего не создаёт — см. комментарий в службе.
 */
@Module({
  imports: [AiModule, PromptsModule],
  controllers: [ChatAnalysisController],
  providers: [ChatAnalysisService, ChatAnalysisRepository, ChatAnalysisScheduler],
  exports: [ChatAnalysisService],
})
export class ChatAnalysisModule {}
