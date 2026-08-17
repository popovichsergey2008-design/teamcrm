import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DiagController } from './diag.controller';
import { DiagService } from './diag.service';

/**
 * Диагностика созвонов и чатов.
 *
 * Глобальный: журнал зовут из сигналинга, чатов и медиа, и тянуть его импортом
 * в каждый модуль — лишний повод забыть и потерять кусок картины.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [DiagController],
  providers: [DiagService],
  exports: [DiagService],
})
export class DiagModule {}
