import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { ChatsService } from '../chats/chats.service';
import { GuestLinksService } from './guest-links.service';
import { MeetGateway } from './meet.gateway';

class CreateGuestLinkDto {
  /** Позвать в идущий созвон. Без него выделяется новая комната под эту ссылку. */
  @IsOptional() @IsString() roomId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsInt() @Min(1) @Max(720) ttlHours?: number;
  /** Разговор, ради которого ссылка выдана: по нему её потом и находят в чате. */
  @IsOptional() @IsString() chatId?: string;
}

class GuestJoinDto {
  @IsString() name!: string;
}
class GuestMessageDto {
  @IsString() token!: string;
  @IsString() body!: string;
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
    private readonly chats: ChatsService,
  ) {}

  /**
   * Разговор, доступный по ссылке.
   *
   * Живёт здесь, а не в модуле чатов, потому что здесь проверяется гостевой токен —
   * а два места проверки одного и того же рано или поздно разойдутся.
   *
   * Токен привязан к ОДНОМУ чату: пересланная ссылка не откроет ничего другого.
   */
  private guestChat(token: string): { tenantId: string; chatId: string; name: string } {
    const payload = this.guests.verify(String(token || ''));
    if (!payload) throw AppException.unauthorized('Ссылка недействительна');
    if (!payload.chatId) throw AppException.forbidden('Эта ссылка только на созвон');
    return { tenantId: payload.tenantId, chatId: String(payload.chatId), name: payload.name };
  }

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

  /** Войти в комнату ранее выданной ссылки: гость ждёт именно её, а не «любой созвон». */
  @Post('meet/guest-links/:id/open')
  @Roles('owner', 'manager', 'member')
  open(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.guests.open(u.tenantId, id);
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

  /** Переписка глазами гостя: только тот чат, ради которого выдана ссылка. */
  @Post('meet/guest/chat/messages')
  @Public()
  guestMessages(@Body() dto: { token: string }) {
    const g = this.guestChat(dto?.token);
    return this.chats.guestMessages(g.tenantId, g.chatId);
  }

  @Post('meet/guest/chat/send')
  @Public()
  guestSend(@Body() dto: GuestMessageDto) {
    const g = this.guestChat(dto?.token);
    return this.chats.guestSend(g.tenantId, g.chatId, g.name, dto.body);
  }

  @Post('meet/guest/:token/join')
  @Public()
  join(@Param('token') token: string, @Body() dto: GuestJoinDto) {
    return this.guests.join(token, dto.name);
  }
}
