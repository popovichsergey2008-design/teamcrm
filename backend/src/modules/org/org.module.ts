import { Global, Module } from '@nestjs/common';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';

/**
 * Структура компании и одно правило подбора исполнителя (#4615, доработка 23.10).
 * Глобальный: подбор нужен форме, быстрой команде, чату, встречам и боту, обучение — задачам.
 */
@Global()
@Module({
  controllers: [OrgController],
  providers: [OrgService],
  exports: [OrgService],
})
export class OrgModule {}
