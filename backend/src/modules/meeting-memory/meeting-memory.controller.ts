import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { MeetingMemoryService } from './meeting-memory.service';

/**
 * #4902, п. 12: память встреч. Свой префикс, а не /meetings/...: там `GET :id`
 * перехватил бы эти маршруты. «Кратко до сих пор» идёт через сокет созвона — запись
 * живёт в памяти процесса, где идёт звонок, а запрос API мог бы попасть в другой.
 */
@ApiTags('meetings')
@ApiBearerAuth()
@Controller('meeting-memory')
@Roles('owner', 'manager', 'member')
export class MeetingMemoryController {
  constructor(private readonly svc: MeetingMemoryService) {}

  /** Карточка «с прошлой встречи»: сколько задач готово, на проверке, не начато. */
  @Get('previous')
  previous(@CurrentUser() u: AuthUser, @Query('room') room?: string) {
    if (!room || room.length > 64) throw AppException.validation('Не указан созвон');
    return this.svc.previous(u, room);
  }

  /** Метка «Кратко до сих пор» → момент разобранной записи (после звонка). */
  @Get('moment')
  moment(@CurrentUser() u: AuthUser, @Query('room') room?: string, @Query('t') t?: string) {
    if (!room || room.length > 64) throw AppException.validation('Не указан созвон');
    return this.svc.moment(u, room, Number(t ?? 0));
  }
}
