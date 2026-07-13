import { Global, Module } from '@nestjs/common';
import { PromptsService } from './prompts.service';
import { PromptRepository } from './prompt.repository';
import { PromptsController } from './prompts.controller';

/**
 * Global: PromptsService доступен ИИ-слою (AiService/BrainService) без явного импорта.
 * PromptOps — версионируемое хранилище инструкций ИИ.
 */
@Global()
@Module({
  controllers: [PromptsController],
  providers: [PromptsService, PromptRepository],
  exports: [PromptsService],
})
export class PromptsModule {}
