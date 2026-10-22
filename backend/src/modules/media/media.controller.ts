import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { MediaService } from './media.service';
import { GuestLinksService } from './guest-links.service';
import { DbService } from '../../database/db.service';

/** Объявляем ДО контроллера: декоратор @Body() читает тип в момент объявления класса. */
class StartRoomDto {
  @IsOptional() @IsString() projectId?: string;
  /** Позвать ИИ-ассистента: он появится в списке участников и включит запись. */
  @IsOptional() @IsBoolean() withAi?: boolean;
  /** Чат, из которого звонят: туда после разбора вернётся карточка с итогом. */
  @IsOptional() @IsString() chatId?: string;
  /** Задача, из которой звонят: туда вернётся итог разговора. */
  @IsOptional() @IsString() taskId?: string;
}

/** Диагностика медиа-слоя: поднялись ли воркеры и какие созвоны идут прямо сейчас. */
@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
@Roles('owner', 'manager', 'member')
export class MediaController {
  constructor(private readonly media: MediaService, private readonly guests: GuestLinksService, private readonly db: DbService) {}

  /** Почему «Позвонить» не работает — ответ здесь, а не в логах контейнера. */
  @Get('health')
  health() {
    return this.media.health();
  }

  @Get('rooms')
  rooms(@CurrentUser() u: AuthUser) {
    return this.media.activeRooms(u.tenantId, u.userId, (room) => this.guests.isRoomMember(u.tenantId, room.id, u.userId));
  }

  /** Настройки соединения для браузера. Учётные данные TURN временные — см. MediaService. */
  @Get('ice')
  ice(@CurrentUser() u: AuthUser) {
    return { iceServers: this.media.iceServers(u.userId) };
  }

  /** Начать созвон: комната живёт в памяти, участники входят по WebSocket. */
  @Post('rooms')
  async start(@CurrentUser() u: AuthUser, @Body() dto: StartRoomDto) {
    /*
      Автопротокол (ТЗ-34, 3.4): человек разрешил в службе заботы записывать каждый свой
      созвон — ИИ зовём сам, даже если кнопка звонка его не просила. Остановить запись
      можно в самом созвоне, как обычно.
    */
    const auto = dto.withAi === true ? true : !!(await this.db.one<{ on: boolean | null }>(
      `SELECT (ui_prefs->>'autoProtocol') = 'true' AS on FROM users WHERE tenant_id=$1 AND id=$2`,
      [u.tenantId, u.userId],
    ).catch(() => null))?.on;
    const room = await this.media.createRoom(
      u.tenantId, dto.projectId ?? null, auto, u.userId, dto.chatId ?? null, dto.taskId ?? null,
    );
    return { id: room.id, projectId: room.projectId, aiEnabled: room.aiEnabled };
  }
}
