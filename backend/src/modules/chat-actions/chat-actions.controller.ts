import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { ChatActionsService } from './chat-actions.service';

class CreateItemDto {
  @IsString() @MaxLength(16)
  key!: string;

  @IsOptional() @IsString() @MaxLength(255)
  title?: string;

  @IsOptional() @IsString() @Matches(/^\d*$/)
  assigneeId?: string | null;

  @IsOptional() @IsString() @Matches(/^(\d{4}-\d{2}-\d{2})?$/)
  deadline?: string | null;

  @IsOptional() @IsString() @Matches(/^\d*$/)
  linkTaskId?: string | null;

  @IsOptional() @IsBoolean()
  skip?: boolean;
}

class CreateDto {
  @IsOptional() @IsString() @Matches(/^\d*$/)
  projectId?: string | null;

  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => CreateItemDto)
  items?: CreateItemDto[];
}

class AskDto {
  @IsOptional() @IsString() @MaxLength(1000)
  question?: string;
}

class AnswerDto {
  @IsString() @MinLength(1) @MaxLength(4000)
  text!: string;
}

class PingDto {
  @IsString() @Matches(/^\d+$/)
  userId!: string;

  @IsOptional() @IsString() @Matches(/^\d*$/)
  taskId?: string | null;

  @IsIn(['remind', 'ask'])
  kind!: 'remind' | 'ask';

  @IsOptional() @IsString() @MaxLength(1000)
  question?: string;
}

/**
 * Действия с сообщением чата (#4902): п. 7 — поручения → задачи одной кнопкой,
 * п. 8 — «Кто за это отвечает?» из контекста. Префикс не `/chats`: там `GET :id`.
 */
@ApiTags('chat-actions')
@ApiBearerAuth()
@Controller('chat-actions')
@Roles('owner', 'manager', 'member')
export class ChatActionsController {
  constructor(private readonly svc: ChatActionsService) {}

  @Get('messages/:id/tasks')
  tasks(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('auto') auto?: string) {
    return this.svc.tasks(u, id, auto === '1' || auto === 'true');
  }

  @Post('messages/:id/tasks')
  create(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: CreateDto) {
    return this.svc.create(u, id, { projectId: dto.projectId || null, items: dto.items });
  }

  @Post('messages/:id/tasks/dismiss')
  dismiss(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.dismiss(u, id); }

  @Post('messages/:id/ask')
  ask(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AskDto) { return this.svc.ask(u, id, dto.question); }

  @Post('messages/:id/answer')
  answer(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AnswerDto) { return this.svc.answer(u, id, dto.text); }

  @Post('messages/:id/ping')
  ping(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: PingDto) {
    return this.svc.ping(u, id, { userId: dto.userId, taskId: dto.taskId || null, kind: dto.kind, question: dto.question });
  }
}
