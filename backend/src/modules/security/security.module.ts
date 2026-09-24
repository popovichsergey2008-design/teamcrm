import { Global, Module } from '@nestjs/common';
import { SecurityController } from './security.controller';
import { SecurityRepository } from './security.repository';
import { SecurityService } from './security.service';

/**
 * Слой безопасности (ТЗ «Central Security System»).
 *
 * Глобальный намеренно: право спрашивают из задач, интеграций, выгрузок и контактов —
 * то есть отовсюду. Импортировать его в каждый модуль по отдельности значит рано или
 * поздно забыть и оставить действие без проверки.
 */
@Global()
@Module({
  controllers: [SecurityController],
  providers: [SecurityService, SecurityRepository],
  exports: [SecurityService],
})
export class SecurityModule {}
