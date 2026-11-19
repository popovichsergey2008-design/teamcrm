import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { StickersController } from './stickers.controller';
import { StickersRepository } from './stickers.repository';
import { StickersScheduler } from './stickers.scheduler';
import { StickersService } from './stickers.service';

/** Стикеры-напоминалки (#4997). БД и ИИ — глобальные модули. */
@Module({
  // напоминания стикеров (пункт 6): ящик, телефон и Telegram — сервисами уведомлений
  imports: [NotificationsModule],
  controllers: [StickersController],
  providers: [StickersService, StickersRepository, StickersScheduler],
  exports: [StickersService],
})
export class StickersModule {}
