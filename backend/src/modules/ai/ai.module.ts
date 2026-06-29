import { Global, Module } from '@nestjs/common';
import { AiService } from './ai.service';

/** Global: AiService — единственная точка вызовов к LLM/Whisper. */
@Global()
@Module({
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
