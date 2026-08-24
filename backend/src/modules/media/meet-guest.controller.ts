import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { GuestLinksService } from './guest-links.service';
import { MeetGateway } from './meet.gateway';

class CreateGuestLinkDto {
  /** Позвать в идущий созвон. Без него выделяется новая комната под эту ссылку. */
  @IsOptional() @IsString() roomId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsInt() @Min(1) @Max(720) ttlHours?: number;
}

class GuestJoinDto {
  @IsString() name!: string;
}

/**
 * Гостевой доступ в созвон.
 *
 * Два разных мира в одном контроллере: сотрудник заводит и отзывает ссылки, гость
 * по ссылке узнаёт, куда его позвали, и получает токен на ОДНУ комнату. Гостевые
 * маршруты публичны — у гостя нет и не будет учётной записи.
 */
@ApiTags('meet-guest')
@Controller()
export class MeetGuestController {
  constructor(
    private readonly guests: GuestLinksService,
    private readonly gateway: MeetGateway,
  ) {}

  @Post('meet/guest-links')
  @Roles('owner', 'manager', 'member')
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateGuestLinkDto) {
    return this.guests.create(u.tenantId, u.userId, dto);
  }

  @Get('meet/guest-links')
  @Roles('owner', 'manager', 'member')
  list(@CurrentUser() u: AuthUser) {
    return this.guests.list(u.tenantId);
  }

  /** Отзыв действует немедленно: гость по этой ссылке вылетает из комнаты сейчас, а не потом. */
  @Delete('meet/guest-links/:id')
  @Roles('owner', 'manager', 'member')
  async revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const revoked = await this.guests.revoke(u.tenantId, id);
    const kicked = this.gateway.kickRoomGuests(u.tenantId, revoked.roomId);
    return { ...revoked, kicked };
  }

  /** Экран «вас пригласили»: название организации и состояние созвона — и ничего больше. */
  @Get('meet/guest/:token')
  @Public()
  describe(@Param('token') token: string) {
    return this.guests.describe(token);
  }

  @Post('meet/guest/:token/join')
  @Public()
  join(@Param('token') token: string, @Body() dto: GuestJoinDto) {
    return this.guests.join(token, dto.name);
  }
}
