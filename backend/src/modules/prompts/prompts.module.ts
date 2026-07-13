import { Global, Module } from '@nestjs/common';
import { PromptsService } from './prompts.service';
import { PromptRepository } from './prompt.repository';
import { PromptsController } from './prompts.controller';
import { PromptFeedbackController } from './prompt-feedback.controller';

/**
 * Global: PromptsService доступен ИИ-слою (AiService/BrainService) без явного импорта.
 * PromptOps — версионируемое хранилище инструкций ИИ.
 */
@Global()
@Module({
  controllers: [PromptsController, PromptFeedbackController],
  providers: [PromptsService, PromptRepository],
  exports: [PromptsService],
})
export class PromptsModule {}
