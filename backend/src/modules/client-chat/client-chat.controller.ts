import { Body, Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { Request } from 'express';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AuthThrottleService, ThrottleRule } from '../auth/auth-throttle.service';
import { ClientChatService } from './client-chat.service';

class CreateLinkDto {
  @IsOptional() @IsString() @MaxLength(120) label?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) days?: number;
}

class OpenTaskDto {
  @IsString() @MaxLength(20) taskId!: string;
}

class JoinDto {
  @IsString() @MinLength(2) @MaxLength(60) name!: string;
  @IsOptional() @IsString() @MaxLength(320) email?: string;
}

class SessionDto {
  @IsString() @MaxLength(64) session!: string;
}

class MessagesDto extends SessionDto {
  @IsOptional() @IsString() @MaxLength(20) afterId?: string;
}

class SendDto extends SessionDto {
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
}

/** Пределы публичных ручек: лента опрашивается раз в 5 с — с запасом на две вкладки. */
const VIEW_IP: ThrottleRule = { name: 'cc:view', limit: 600, windowSec: 10 * 60 };
const JOIN_IP: ThrottleRule = { name: 'cc:join', limit: 20, windowSec: 60 * 60 };
const SEND_IP: ThrottleRule = { name: 'cc:send', limit: 60, windowSec: 10 * 60 };
const SEND_SESSION: ThrottleRule = { name: 'cc:send:s', limit: 20, windowSec: 60 };
const CALL_IP: ThrottleRule = { name: 'cc:call', limit: 20, windowSec: 10 * 60 };

/** Сотрудник: ссылки для клиента, открытые ему задачи, подсказка ответа (#4902, п. 15). */
@ApiTags('client-chat')
@ApiBearerAuth()
@Controller('client-chat')
@Roles('owner', 'manager', 'member')
export class ClientChatController {
  constructor(private readonly svc: ClientChatService) {}

  @Get('chats/:chatId')
  overview(@CurrentUser() u: AuthUser, @Param('chatId') chatId: string) { return this.svc.overview(u, chatId); }

  @Post('chats/:chatId/links')
  createLink(@CurrentUser() u: AuthUser, @Param('chatId') chatId: string, @Body() dto: CreateLinkDto) { return this.svc.createLink(u, chatId, dto); }

  @Delete('links/:id')
  revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.revokeLink(u, id); }

  @Get('chats/:chatId/candidates')
  candidates(@CurrentUser() u: AuthUser, @Param('chatId') chatId: string, @Query('q') q?: string) { return this.svc.candidates(u, chatId, q ?? null); }

  @Post('chats/:chatId/tasks')
  openTask(@CurrentUser() u: AuthUser, @Param('chatId') chatId: string, @Body() dto: OpenTaskDto) { return this.svc.openTask(u, chatId, dto.taskId); }

  @Delete('chats/:chatId/tasks/:taskId')
  closeTask(@CurrentUser() u: AuthUser, @Param('chatId') chatId: string, @Param('taskId') taskId: string) { return this.svc.closeTask(u, chatId, taskId); }

  @Post('chats/:chatId/suggest')
  suggest(@CurrentUser() u: AuthUser, @Param('chatId') chatId: string) { return this.svc.suggest(u, chatId); }
}

/**
 * Гость без учётной записи — страница `/cc/<токен>`. Всё публично и с пределами частоты;
 * после входа гость ходит с ключом сессии, а не с токеном ссылки и не с JWT сотрудника.
 */
@ApiTags('client-chat')
@Controller('client-chat/public')
export class ClientChatPublicController {
  constructor(private readonly svc: ClientChatService, private readonly throttle: AuthThrottleService) {}

  @Public()
  @Post('session/me')
  async me(@Body() dto: SessionDto, @Req() req: Request) {
    await this.throttle.hit(VIEW_IP, req.ip);
    return this.svc.me(dto.session);
  }

  @Public()
  @Post('session/messages')
  async messages(@Body() dto: MessagesDto, @Req() req: Request) {
    await this.throttle.hit(VIEW_IP, req.ip);
    return this.svc.messages(dto.session, dto.afterId ?? null);
  }

  @Public()
  @Post('session/send')
  async send(@Body() dto: SendDto, @Req() req: Request) {
    await this.throttle.hit(SEND_IP, req.ip);
    await this.throttle.hit(SEND_SESSION, dto.session);
    return this.svc.send(dto.session, dto.body);
  }

  @Public()
  @Post('session/tasks')
  async tasks(@Body() dto: SessionDto, @Req() req: Request) {
    await this.throttle.hit(VIEW_IP, req.ip);
    return this.svc.tasks(dto.session);
  }

  @Public()
  @Post('session/call')
  async call(@Body() dto: SessionDto, @Req() req: Request) {
    await this.throttle.hit(CALL_IP, req.ip);
    return this.svc.call(dto.session);
  }

  @Public()
  @Get(':token')
  async describe(@Param('token') token: string, @Req() req: Request) {
    await this.throttle.hit(VIEW_IP, req.ip);
    return this.svc.describe(token);
  }

  @Public()
  @Post(':token/join')
  async join(@Param('token') token: string, @Body() dto: JoinDto, @Req() req: Request) {
    await this.throttle.hit(JOIN_IP, req.ip);
    return this.svc.join(token, dto.name, dto.email ?? null);
  }
}
