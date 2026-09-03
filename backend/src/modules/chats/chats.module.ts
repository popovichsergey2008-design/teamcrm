import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { NlModule } from '../nl/nl.module';
import { ChatsController } from './chats.controller';
import { ChatsRepository } from './chats.repository';
import { ChatsService } from './chats.service';
import { RemindersScheduler } from './reminders.scheduler';
import { ChatsAiService } from './chats-ai.service';
import { AiModule } from '../ai/ai.module';

/**
 * Этап 6, М1 — мессенджер команды: личные диалоги, группы, чаты проектов.
 * ТЗ-3: треды, реакции, закрепления, сохранённое, напоминания, упоминания.
 *
 * NotificationsModule нужен ради Telegram: напоминание, пришедшее в закрытую вкладку,
 * не напомнило ни о чём.
 */
@Module({
  imports: [RealtimeModule, NotificationsModule, NlModule, AiModule],
  controllers: [ChatsController],
  providers: [ChatsService, ChatsRepository, RemindersScheduler, ChatsAiService],
  exports: [ChatsService],
})
export class ChatsModule {}
