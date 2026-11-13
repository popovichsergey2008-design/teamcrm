import { Module } from '@nestjs/common';
import { LinkCardsController } from './link-cards.controller';
import { LinkCardsRepository } from './link-cards.repository';
import { LinkCardsService } from './link-cards.service';

/**
 * Живые карточки ссылок в переписке (#4902, п. 3). Файлы и слой безопасности —
 * глобальные модули, поэтому импортов нет: модуль только читает.
 */
@Module({
  controllers: [LinkCardsController],
  providers: [LinkCardsService, LinkCardsRepository],
})
export class LinkCardsModule {}
