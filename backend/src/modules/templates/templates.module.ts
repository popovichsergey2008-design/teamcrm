import { Module } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { TemplatesRepository } from './templates.repository';
import { TemplatesService } from './templates.service';

/**
 * Шаблоны задач.
 *
 * Отдельным модулем, а не внутри задач: шаблоном пользуются и карточка (сохранить),
 * и форма создания (применить), и когда-нибудь быстрая команда. Общего с задачами у
 * него ровно один запрос — прочитать образец, — и ради него связывать модули незачем.
 */
@Module({
  controllers: [TemplatesController],
  providers: [TemplatesService, TemplatesRepository],
  exports: [TemplatesService],
})
export class TemplatesModule {}
