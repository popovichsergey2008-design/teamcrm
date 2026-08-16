import { Module } from '@nestjs/common';
import { MeetingsModule } from '../meetings/meetings.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MeetGateway } from './meet.gateway';
import { RecordingService } from './recording.service';

/**
 * Этап 6, Ш1 — SFU-слой созвонов (mediasoup), перенесённый из TeamConnect.
 * Модуль подключается всегда: при отсутствии mediasoup он просто сообщает,
 * что созвоны недоступны, и не мешает остальной CRM.
 */
@Module({
  imports: [MeetingsModule], // запись созвона отдаётся в тот же конвейер, что и загруженные встречи
  controllers: [MediaController],
  providers: [MediaService, MeetGateway, RecordingService],
  exports: [MediaService],
})
export class MediaModule {}
