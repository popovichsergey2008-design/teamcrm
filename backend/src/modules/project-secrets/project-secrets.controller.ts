import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { ProjectSecretsService } from './project-secrets.service';

class MoveSecretDto {
  /** Отрезок секрета в тексте сообщения — как его вернул сервер в secret_spans. */
  @IsInt() @Min(0) start!: number;
  @IsInt() @Min(1) end!: number;
  @IsOptional() @IsString() @MaxLength(160) title?: string;
  /** Чат без проекта: куда положить секрет — выбирает человек. */
  @IsOptional() @IsString() @MaxLength(20) projectId?: string;
}

/**
 * «Секреты» проекта (#4902, п. 13). Заказчику (client) — закрыто целиком: пароли
 * команды не для внешних людей, даже если проект их.
 */
@ApiTags('project-secrets')
@ApiBearerAuth()
@Controller('project-secrets')
@Roles('owner', 'manager', 'member')
export class ProjectSecretsController {
  constructor(private readonly secrets: ProjectSecretsService) {}

  private viewer(u: AuthUser) {
    return { userId: u.userId, role: u.role };
  }

  @Get('messages/:messageId/spans')
  spans(@CurrentUser() u: AuthUser, @Param('messageId') messageId: string) {
    return this.secrets.spans(u.tenantId, messageId, this.viewer(u));
  }

  @Get('messages/:messageId')
  ofMessage(@CurrentUser() u: AuthUser, @Param('messageId') messageId: string) {
    return this.secrets.ofMessage(u.tenantId, messageId, this.viewer(u));
  }

  @Post('messages/:messageId')
  move(@CurrentUser() u: AuthUser, @Param('messageId') messageId: string, @Body() dto: MoveSecretDto) {
    return this.secrets.moveFromMessage(u.tenantId, messageId, this.viewer(u), dto);
  }

  @Get('projects/:projectId')
  list(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string) {
    return this.secrets.list(u.tenantId, projectId, this.viewer(u));
  }

  @Get(':id/value')
  reveal(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.secrets.reveal(u.tenantId, id, this.viewer(u));
  }

  @Delete(':id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.secrets.remove(u.tenantId, id, this.viewer(u));
  }
}
