import { Global, Module } from '@nestjs/common';
import { SecretaryController } from './secretary.controller';
import { SecretaryService } from './secretary.service';

/**
 * Глобальный намеренно: журнал авто-действий пишут разные модули — встречи,
 * входящие, агент, быстрая команда. Прописывать импорт в каждый из них значит
 * рано или поздно забыть в новом месте, и действие тихо не попадёт в журнал.
 * Ровно так же в проекте объявлены кэш и база.
 */
@Global()
@Module({
  controllers: [SecretaryController],
  providers: [SecretaryService],
  exports: [SecretaryService],
})
export class SecretaryModule {}
