import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { MediaService } from './media.service';

/** Объявляем ДО контроллера: декоратор @Body() читает тип в момент объявления класса. */
class StartRoomDto {
  @IsOptional() @IsString() projectId?: string;
  /** Позвать ИИ-ассистента: он появится в списке участников и включит запись. */
  @IsOptional() @IsBoolean() withAi?: boolean;
  /** Чат, из которого звонят: туда после разбора вернётся карточка с итогом. */
  @IsOptional() @IsString() chatId?: string;
}

/** Диагностика медиа-слоя: поднялись ли воркеры и какие созвоны идут прямо сейчас. */
@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
@Roles('owner', 'manager', 'member')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** Почему «Позвонить» не работает — ответ здесь, а не в логах контейнера. */
  @Get('health')
  health() {
    return this.media.health();
  }

  @Get('rooms')
  rooms(@CurrentUser() u: AuthUser) {
    return this.media.activeRooms(u.tenantId);
  }

  /** Настройки соединения для браузера. Учётные данные TURN временные — см. MediaService. */
  @Get('ice')
  ice(@CurrentUser() u: AuthUser) {
    return { iceServers: this.media.iceServers(u.userId) };
  }

  /** Начать созвон: комната живёт в памяти, участники входят по WebSocket. */
  @Post('rooms')
  async start(@CurrentUser() u: AuthUser, @Body() dto: StartRoomDto) {
    const room = await this.media.createRoom(
      u.tenantId, dto.projectId ?? null, dto.withAi === true, u.userId, dto.chatId ?? null,
    );
    return { id: room.id, projectId: room.projectId, aiEnabled: room.aiEnabled };
  }
}
