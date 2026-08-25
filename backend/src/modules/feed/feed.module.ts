import { Module } from '@nestjs/common';
import { FeedController } from './feed.controller';
import { FeedRepository } from './feed.repository';
import { FeedService } from './feed.service';

/**
 * ТЗ-2, этап 6, шаг 5 — лента компании.
 * Чаты закрывают общение, лента — объявления: то, что обязаны прочитать все.
 */
@Module({
  controllers: [FeedController],
  providers: [FeedService, FeedRepository],
})
export class FeedModule {}
