import { Body, Controller, Delete, Get, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Response } from 'express';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { AnthillService, PageContext } from './anthill.service';

class ContextDto {
  @IsIn(['task', 'project', 'chat', 'meeting']) type!: PageContext['type'];
  @IsString() @MaxLength(32) id!: string;
}
class StartDto {
  @IsOptional() @ValidateNested() @Type(() => ContextDto) context?: ContextDto;
}
class AskDto {
  @IsString() @MinLength(2) @MaxLength(8000) question!: string;
  @IsOptional() @ValidateNested() @Type(() => ContextDto) context?: ContextDto;
}
class EditDto {
  /** Значения полей карточки: их состав задаёт сам инструмент (fields). */
  @IsObject() patch!: Record<string, string>;
}
class FeedbackDto {
  @IsInt() @IsIn([1, -1]) vote!: 1 | -1;
  @IsOptional() @IsIn(['inaccurate', 'not_found', 'invented', 'wrong_context', 'wording', 'other']) reason?: string;
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}

/**
 * AnthillBot (ТЗ-6). Клиенту (портал) агент не показывается: у него свои данные и свой экран.
 */
@ApiTags('anthill')
@ApiBearerAuth()
@Controller('anthill')
@Roles('owner', 'manager', 'member')
export class AnthillController {
  constructor(private readonly anthill: AnthillService) {}

  @Get('sessions')
  sessions(@CurrentUser() u: AuthUser) {
    return this.anthill.sessions(u.tenantId, u.userId);
  }

  /** «+ Новый разговор» — с контекстом страницы, если он есть. */
  @Post('sessions')
  start(@CurrentUser() u: AuthUser, @Body() dto: StartDto) {
    return this.anthill.start(u.tenantId, u.userId, dto.context ?? null);
  }

  @Get('sessions/:id/messages')
  messages(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.anthill.messages(u.tenantId, u.userId, id);
  }

  @Delete('sessions/:id')
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.anthill.remove(u.tenantId, u.userId, id);
  }

  /**
   * Вопрос — потоком (SSE): status* → delta* → sources | action → done.
   * Разрыв соединения = «Остановить»: набранная часть уже сохранена по мере прихода.
   */
  @Post('sessions/:id/ask')
  async ask(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AskDto, @Res() res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    let closed = false;
    res.on('close', () => { closed = true; });
    const send = (event: string, data: unknown) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    try {
      await this.anthill.ask(u.tenantId, u, id, dto.question, dto.context ?? null, (e) => send(e.type, e), () => closed);
    } catch (e) {
      send('error', { text: e instanceof AppException ? e.message : 'Не удалось получить ответ. Попробуйте снова.' });
    } finally {
      if (!closed) res.end();
    }
  }

  @Post('actions/:id/confirm')
  confirm(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.anthill.confirm(u.tenantId, u, id);
  }

  /** Поправить карточку до «Создать» — ТЗ-6, разд. 62. */
  @Post('actions/:id/edit')
  edit(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: EditDto) {
    return this.anthill.edit(u.tenantId, u, id, dto.patch);
  }

  @Post('actions/:id/reject')
  reject(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.anthill.reject(u.tenantId, u, id);
  }

  @Post('actions/:id/undo')
  undo(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.anthill.undo(u.tenantId, u, id);
  }

  @Get('actions')
  actions(@CurrentUser() u: AuthUser) {
    return this.anthill.actions(u.tenantId, u.userId);
  }

  @Post('messages/:id/feedback')
  feedback(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: FeedbackDto) {
    return this.anthill.feedback(u.tenantId, u.userId, id, dto.vote, dto.reason ?? null, dto.comment ?? null);
  }
}
