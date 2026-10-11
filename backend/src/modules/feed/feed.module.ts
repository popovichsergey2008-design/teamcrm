import { Module } from '@nestjs/common';
import { FeedController } from './feed.controller';
import { FeedRepository } from './feed.repository';
import { FeedService } from './feed.service';
import { NewsAgentService } from './news-agent.service';
import { NewsFactsRepository } from './news-facts.repository';
import { NewsScheduler } from './news.scheduler';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * «Новости» (ТЗ-2 этап 6 → ТЗ-20): лента значимых событий компании — новости и
 * объявления, спасибо коллегам, опросы, релизы и вехи, хайлайт дня и выводы недели.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [FeedController],
  providers: [FeedService, FeedRepository, NewsFactsRepository, NewsAgentService, NewsScheduler],
  // счётчик в панели, «Пульс» (победа) и бот пользуются тем же сервисом
  exports: [FeedService, NewsAgentService],
})
export class FeedModule {}
