import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { PromptsModule } from '../prompts/prompts.module';
import { SmartReplyController } from './smart-reply.controller';
import { SmartReplyService } from './smart-reply.service';

/** Готовый ответ в чате (ТЗ-21, этап 5). Настройки — из проактивного секретаря (глобальный модуль). */
@Module({
  imports: [AiModule, PromptsModule],
  controllers: [SmartReplyController],
  providers: [SmartReplyService],
})
export class SmartReplyModule {}
