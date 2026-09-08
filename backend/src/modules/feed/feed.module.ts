import { Module } from '@nestjs/common';
import { FeedController } from './feed.controller';
import { FeedRepository } from './feed.repository';
import { FeedService } from './feed.service';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * ТЗ-2, этап 6, шаг 5 — лента компании.
 * Чаты закрывают общение, лента — объявления: то, что обязаны прочитать все.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [FeedController],
  providers: [FeedService, FeedRepository],
  exports: [FeedService], // счётчик «Новости» в левой панели считает тот же сервис
})
export class FeedModule {}
