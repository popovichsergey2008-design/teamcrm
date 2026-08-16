import { Body, Controller, Delete, Get, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { ChatsService } from './chats.service';

class OpenDmDto {
  @IsString() userId!: string;
}
class CreateGroupDto {
  @IsString() @MaxLength(160) title!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) userIds?: string[];
}
class SendDto {
  @IsOptional() @IsString() @MaxLength(8000) body?: string;
}

/** Мессенджер команды. Роль client сюда не допускается — у заказчика свой портал. */
@ApiTags('chats')
@ApiBearerAuth()
@Controller('chats')
@Roles('owner', 'manager', 'member')
export class ChatsController {
  constructor(private readonly chats: ChatsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.chats.list(u.tenantId, u.userId);
  }

  /** Открыть личный диалог (создаётся при первом обращении). */
  @Post('dm')
  openDm(@CurrentUser() u: AuthUser, @Body() dto: OpenDmDto) {
    return this.chats.openDm(u.tenantId, u.userId, dto.userId);
  }

  @Post('groups')
  createGroup(@CurrentUser() u: AuthUser, @Body() dto: CreateGroupDto) {
    return this.chats.createGroup(u.tenantId, u.userId, dto.title, dto.userIds ?? []);
  }

  /** Чат доски проекта — обсуждение рядом с задачами, а не в отдельном мессенджере. */
  @Post('project/:projectId')
  openProject(@CurrentUser() u: AuthUser, @Param('projectId') projectId: string) {
    return this.chats.openProjectChat(u.tenantId, u.userId, u.role, projectId);
  }

  @Get(':id/messages')
  messages(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('before') before?: string) {
    return this.chats.messages(u.tenantId, id, u, before);
  }

  @Post(':id/messages')
  send(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: SendDto) {
    return this.chats.send(u.tenantId, id, u, dto.body ?? '', null);
  }

  @Post(':id/files')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  sendFile(
    @CurrentUser() u: AuthUser, @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File, @Body() dto: SendDto,
  ) {
    if (!file) throw AppException.validation('Файл не приложен');
    return this.chats.sendFile(u.tenantId, id, u, file, dto.body ?? '');
  }

  @Post(':id/read')
  read(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.chats.markRead(u.tenantId, id, u);
  }

  @Delete(':id/messages/:messageId')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('messageId') messageId: string) {
    return this.chats.remove(u.tenantId, id, messageId, u);
  }
}
