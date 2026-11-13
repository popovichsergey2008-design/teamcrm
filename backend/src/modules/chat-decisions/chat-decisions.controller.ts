import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { ChatDecisionsService } from './chat-decisions.service';

class TextDto {
  @IsOptional() @IsString() @MaxLength(1000)
  text?: string;
}

class CandidateDto extends TextDto {
  @IsBoolean()
  accept!: boolean;
}

class DoneDto {
  @IsBoolean()
  done!: boolean;
}

class TaskDto {
  @IsOptional() @IsString() @MaxLength(20)
  taskId?: string;

  @IsOptional() @IsString() @MaxLength(20)
  assigneeId?: string;

  @IsOptional() @IsString() @MaxLength(300)
  title?: string;
}

class ResolveDto {
  @IsString() @MinLength(3) @MaxLength(64)
  key!: string;

  @IsIn(['poll', 'call', 'decided', 'dismissed', 'reopen'])
  how!: 'poll' | 'call' | 'decided' | 'dismissed' | 'reopen';

  @IsOptional() @IsString() @MaxLength(1000)
  text?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(100, { each: true })
  options?: string[];
}

/** Вкладка «Решения» чата (#4902, п. 9). Доступ — по членству в чате (или видимому чату проекта). */
@ApiTags('chat-decisions')
@ApiBearerAuth()
@Controller('chat-decisions')
@Roles('owner', 'manager', 'member')
export class ChatDecisionsController {
  constructor(private readonly svc: ChatDecisionsService) {}

  /** Решения, кандидаты и вопросы без ответа чата. */
  @Get('chats/:chatId')
  tab(@CurrentUser() u: AuthUser, @Param('chatId') chatId: string) { return this.svc.tab(u, chatId); }

  /** ИИ предлагает кандидатов (нет модели — остаются кандидаты правил). */
  @Post('chats/:chatId/suggest')
  suggest(@CurrentUser() u: AuthUser, @Param('chatId') chatId: string) { return this.svc.suggest(u, chatId); }

  /** «Решить» вопрос без ответа: опрос, созвон, записать решение, «не вопрос», вернуть. */
  @Post('chats/:chatId/questions')
  resolve(@CurrentUser() u: AuthUser, @Param('chatId') chatId: string, @Body() dto: ResolveDto) {
    return this.svc.resolveQuestion(u, chatId, dto);
  }

  /** «Отметить как решение» из меню сообщения. */
  @Post('messages/:messageId')
  mark(@CurrentUser() u: AuthUser, @Param('messageId') messageId: string, @Body() dto: TextDto) {
    return this.svc.markMessage(u, messageId, dto.text);
  }

  @Post('candidates/:id')
  candidate(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: CandidateDto) {
    return this.svc.resolveCandidate(u, id, dto.accept, dto.text);
  }

  @Post(':id/done')
  done(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DoneDto) { return this.svc.setDone(u, id, dto.done); }

  @Post(':id/task')
  task(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: TaskDto) { return this.svc.task(u, id, dto); }

  @Post(':id/revoke')
  revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.revoke(u, id); }
}
