import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { MeetGateway } from './meet.gateway';

/**
 * Этап 6, Ш1 — SFU-слой созвонов (mediasoup), перенесённый из TeamConnect.
 * Модуль подключается всегда: при отсутствии mediasoup он просто сообщает,
 * что созвоны недоступны, и не мешает остальной CRM.
 */
@Module({
  controllers: [MediaController],
  providers: [MediaService, MeetGateway],
  exports: [MediaService],
})
export class MediaModule {}
