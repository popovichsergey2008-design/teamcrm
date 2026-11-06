import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CalendarModule } from '../calendar/calendar.module';
import { FilesModule } from '../files/files.module';
import { MediaModule } from '../media/media.module';
import { BookingController, BookingPublicController } from './booking.controller';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';

/**
 * Запись по ссылке (#4787, п. 6–9) — отдельным модулем: ей нужны и календарь (встреча
 * организатора), и созвоны (личная ссылка гостя), а календарь и созвоны друг о друге не знают.
 */
@Module({
  imports: [AuthModule, CalendarModule, MediaModule, FilesModule],
  controllers: [BookingController, BookingPublicController],
  providers: [BookingService, BookingRepository],
})
export class BookingModule {}
