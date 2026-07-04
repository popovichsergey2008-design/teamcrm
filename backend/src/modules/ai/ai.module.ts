import { Global, Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { AiUsageController } from './ai-usage.controller';

/** Global: AiService — единственная точка вызовов к LLM/Whisper. */
@Global()
@Module({
  controllers: [AiUsageController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
