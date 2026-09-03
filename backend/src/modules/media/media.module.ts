import { Module } from '@nestjs/common';
import { MeetingsModule } from '../meetings/meetings.module';
import { ChatsModule } from '../chats/chats.module';
import { GuestLinksRepository } from './guest-links.repository';
import { GuestLinksService } from './guest-links.service';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MeetGuestController } from './meet-guest.controller';
import { MeetGateway } from './meet.gateway';
import { RecordingService } from './recording.service';

/**
 * Этап 6, Ш1 — SFU-слой созвонов (mediasoup), перенесённый из TeamConnect.
 * Модуль подключается всегда: при отсутствии mediasoup он просто сообщает,
 * что созвоны недоступны, и не мешает остальной CRM.
 */
@Module({
  // ChatsModule — внешний участник по ссылке попадает и в переписку, а не только
  // в переговорную; проверка гостевого токена при этом остаётся здесь, в одном месте.
  imports: [MeetingsModule, ChatsModule],
  controllers: [MediaController, MeetGuestController],
  providers: [MediaService, MeetGateway, RecordingService, GuestLinksService, GuestLinksRepository],
  exports: [MediaService],
})
export class MediaModule {}
