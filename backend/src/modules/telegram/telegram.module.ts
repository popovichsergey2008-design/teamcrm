import { Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { TelegramRepository } from './telegram.repository';
import { TelegramSender } from './telegram.sender';

@Module({
  controllers: [TelegramController],
  providers: [TelegramService, TelegramRepository, TelegramSender],
  exports: [TelegramService, TelegramSender],
})
export class TelegramModule {}
