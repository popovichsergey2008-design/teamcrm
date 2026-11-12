import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { CalendarModule } from '../calendar/calendar.module';
import { ChatsModule } from '../chats/chats.module';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TelegramModule } from '../telegram/telegram.module';
import { CaldavService } from './caldav.service';
import { CalendarPlusController } from './calendar-plus.controller';
import { CalendarPlusRepository } from './calendar-plus.repository';
import { CalendarPlusService } from './calendar-plus.service';
import { ChatMeetingService } from './chat-meeting.service';
import { MeetingPrepService } from './meeting-prep.service';

/**
 * #4892 ТЗ «Календарь»: видеть время → договориться → подготовиться → сделать.
 * Отдельным модулем поверх календаря: чатам и календарю не нужно знать друг о друге —
 * связь через хуки (chat-hooks, calendar-hooks).
 */
@Module({
  imports: [CalendarModule, ChatsModule, RealtimeModule, AiModule, NotificationsModule, TelegramModule],
  controllers: [CalendarPlusController],
  providers: [CalendarPlusService, CalendarPlusRepository, MeetingPrepService, ChatMeetingService, CaldavService, IntegrationCryptoService],
  exports: [CalendarPlusService, CalendarPlusRepository],
})
export class CalendarPlusModule {}
