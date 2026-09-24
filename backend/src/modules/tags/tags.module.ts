import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TagsController, TaskTagsController } from './tags.controller';
import { TagsRepository } from './tags.repository';
import { TagsService } from './tags.service';

/**
 * Теги задач и разметка их через ИИ (ТЗ «Теги задач + автоматическая AI-разметка»).
 *
 * Отдельный модуль, а не часть карточки задачи: тегами пользуются четыре разных места
 * — карточка, форма создания, быстрая команда с пакетом задач и реестр `/tasks`, — и
 * складывать общую логику в одно из них значит обречь остальные ходить туда за ней.
 */
@Module({
  imports: [AiModule, RealtimeModule],
  controllers: [TagsController, TaskTagsController],
  providers: [TagsService, TagsRepository],
  exports: [TagsService],
})
export class TagsModule {}
