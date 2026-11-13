import { GuestSessionsRepository } from './guest-sessions.repository';
import { CallLogService } from './call-log.service';
import { Module } from '@nestjs/common';
import { MeetingsModule } from '../meetings/meetings.module';
import { ChatsModule } from '../chats/chats.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { GuestLinksRepository } from './guest-links.repository';
import { GuestLinksService } from './guest-links.service';
import { GuestLinksScheduler } from './guest-links.scheduler';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MeetGuestController } from './meet-guest.controller';
import { MeetGateway } from './meet.gateway';
import { RecordingService } from './recording.service';
import { CalendarModule } from '../calendar/calendar.module';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { MeetingMemoryModule } from '../meeting-memory/meeting-memory.module';

/**
 * Этап 6, Ш1 — SFU-слой созвонов (mediasoup), перенесённый из TeamConnect.
 * Модуль подключается всегда: при отсутствии mediasoup он просто сообщает,
 * что созвоны недоступны, и не мешает остальной CRM.
 */
@Module({
  // ChatsModule — внешний участник по ссылке попадает и в переписку, а не только
  // в переговорную; проверка гостевого токена при этом остаётся здесь, в одном месте.
  // MeetingMemoryModule — #4902 п. 12: «Кратко до сих пор» читает идущую запись этого процесса
  imports: [MeetingsModule, ChatsModule, NotificationsModule, CalendarModule, MeetingMemoryModule],
  controllers: [MediaController, MeetGuestController],
  providers: [MediaService, MeetGateway, CallLogService, RecordingService, GuestLinksService, GuestLinksRepository, GuestLinksScheduler, IntegrationCryptoService, GuestSessionsRepository],
  // #4902 п. 15: MeetGateway — чат с клиентом при отзыве ссылки выводит гостя из созвона
  exports: [MediaService, GuestLinksService, GuestLinksRepository, GuestSessionsRepository, MeetGateway],
})
export class MediaModule {}
