import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { BrainService } from './brain.service';

class AskDto {
  @IsString() @MinLength(2) question!: string;
  @IsOptional() @IsString() projectId?: string;
}

@ApiTags('brain')
@ApiBearerAuth()
@Controller('brain')
@Roles('owner', 'manager', 'member') // корпоративный разум — внутренний, client не имеет доступа
export class BrainController {
  constructor(private readonly brain: BrainService) {}

  @Post('conversations')
  start(@CurrentUser() u: AuthUser) {
    return this.brain.start(u.tenantId, u.userId);
  }

  @Get('conversations')
  list(@CurrentUser() u: AuthUser) {
    return this.brain.list(u.tenantId, u.userId);
  }

  @Get('conversations/:id/messages')
  messages(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.brain.messages(u.tenantId, u.userId, id);
  }

  @Post('conversations/:id/ask')
  ask(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AskDto) {
    return this.brain.ask(u.tenantId, u.userId, id, dto.question, dto.projectId || undefined);
  }

  /** Стрим ответа (SSE): события citations → delta* → done|error. Читается фронтом через fetch+ReadableStream. */
  @Post('conversations/:id/ask/stream')
  async askStream(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AskDto, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx: не буферизировать SSE
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const r = await this.brain.askStream(u.tenantId, u.userId, id, dto.question, dto.projectId || undefined, {
        citations: (c) => send('citations', { citations: c }),
        delta: (t) => send('delta', { text: t }),
      });
      send('done', { messageId: r.messageId, cached: r.cached, promptVersionId: r.promptVersionId });
    } catch (e) {
      const message = e instanceof AppException ? e.message : 'Ошибка генерации ответа';
      send('error', { message });
    } finally {
      res.end();
    }
  }
}
