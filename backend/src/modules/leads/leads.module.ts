import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { LeadsController, SiteLeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

/** Заявки с рекламной страницы (квиз «план переезда»). */
@Module({
  imports: [TelegramModule],
  controllers: [LeadsController, SiteLeadsController],
  providers: [LeadsService],
  exports: [LeadsService],
})
export class LeadsModule {}
