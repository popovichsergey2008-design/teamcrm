import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { DiagScope, DiagService } from './diag.service';

class ClientEventDto {
  @IsIn(['meet', 'chat', 'app']) scope!: DiagScope;
  @IsOptional() @IsString() @MaxLength(64) refId?: string;
  @IsString() @MaxLength(48) event!: string;
  @IsOptional() data?: unknown;
  @IsOptional() @IsString() @MaxLength(32) at?: string;
}

class ClientBatchDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ClientEventDto)
  events!: ClientEventDto[];
}

@ApiTags('diagnostics')
@ApiBearerAuth()
@Controller('diag')
export class DiagController {
  constructor(private readonly diag: DiagService) {}

  /**
   * Приём событий из браузера.
   *
   * Половина картины созвона видна только там: состояние соединения, приём
   * дорожек, отказы устройств. По серверным логам этого не восстановить.
   * Доступно любому сотруднику — он присылает события про себя.
   */
  @Post('events')
  @Roles('owner', 'manager', 'member')
  async ingest(@CurrentUser() u: AuthUser, @Body() dto: ClientBatchDto) {
    await this.diag.writeMany(
      (dto.events ?? []).map((e) => ({
        tenantId: u.tenantId, scope: e.scope, refId: e.refId ?? null,
        userId: u.userId, side: 'client' as const, event: e.event, data: e.data, at: e.at ?? null,
      })),
    );
    return { ok: true };
  }

  /** Лента одного созвона: сервер и браузеры вперемешку, по времени. */
  @Get(':scope/:refId')
  @Roles('owner', 'manager')
  timeline(
    @Param('scope') scope: string,
    @Param('refId') refId: string,
    @Query('limit') limit?: string,
  ) {
    const s: DiagScope = scope === 'chat' ? 'chat' : scope === 'app' ? 'app' : 'meet';
    return this.diag.timeline(s, refId, limit ? Number(limit) : undefined);
  }

  /** Последние созвоны — найти нужный, не зная номера. */
  @Get(':scope')
  @Roles('owner', 'manager')
  recent(@Param('scope') scope: string, @Query('limit') limit?: string) {
    const s: DiagScope = scope === 'chat' ? 'chat' : scope === 'app' ? 'app' : 'meet';
    return this.diag.recentRooms(s, limit ? Number(limit) : undefined);
  }
}
