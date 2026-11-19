import { Module } from '@nestjs/common';
import { StickersController } from './stickers.controller';
import { StickersRepository } from './stickers.repository';
import { StickersService } from './stickers.service';

/** Стикеры-напоминалки (#4997). БД и ИИ — глобальные модули. */
@Module({
  controllers: [StickersController],
  providers: [StickersService, StickersRepository],
  exports: [StickersService],
})
export class StickersModule {}
