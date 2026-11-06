import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { FocusSessionService } from './focus-session.service';

class StartDto {
  @IsOptional() @IsString() taskId?: string;
  @IsOptional() @IsString() itemId?: string;
  @IsOptional() @IsInt() @Min(5) @Max(120) minutes?: number;
  /** #4787, п. 12: несколько задач и кто может обратиться срочно */
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) taskIds?: string[];
  @IsOptional() @IsIn(['all', 'selected', 'nobody']) urgentMode?: 'all' | 'selected' | 'nobody';
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) urgentUserIds?: string[];
}

class NotesDto {
  @IsString() @MaxLength(4000) notes!: string;
}

class FinishDto {
  @IsIn(['completed', 'cancelled']) outcome!: 'completed' | 'cancelled';
  /** сразу перерыв на 10 минут */
  @IsOptional() @IsBoolean() takeBreak?: boolean;
}

class OutcomeItem {
  @IsString() taskId!: string;
  @IsIn(['done', 'later', 'more']) result!: 'done' | 'later' | 'more';
}

class OutcomesDto {
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => OutcomeItem) results!: OutcomeItem[];
}

class KnockDto {
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

class PreflightQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(120) minutes?: number;
}

/** Глубокая работа (ТЗ-16, п. 96, 98). Своя сессия — только своя. */
@ApiTags('focus')
@ApiBearerAuth()
@Controller()
@Roles('owner', 'manager', 'member')
export class FocusSessionController {
  constructor(private readonly sessions: FocusSessionService) {}

  private me(u: AuthUser) {
    return { tenantId: u.tenantId, userId: u.userId, role: u.role };
  }

  @Get('focus/sessions/current')
  current(@CurrentUser() u: AuthUser) {
    return this.sessions.current(this.me(u));
  }

  @Get('focus/workday')
  workday(@CurrentUser() u: AuthUser) {
    return this.sessions.workday(this.me(u));
  }

  /** Нет ли встречи раньше конца фокуса — до старта. */
  @Get('focus/sessions/preflight')
  preflight(@CurrentUser() u: AuthUser, @Query() q: PreflightQuery) {
    return this.sessions.preflight(this.me(u), q.minutes);
  }

  @Post('focus/sessions')
  start(@CurrentUser() u: AuthUser, @Body() dto: StartDto) {
    return this.sessions.start(this.me(u), dto);
  }

  @Post('focus/sessions/:id/pause')
  pause(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.sessions.pause(this.me(u), id);
  }

  @Post('focus/sessions/:id/resume')
  resume(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.sessions.resume(this.me(u), id);
  }

  @Put('focus/sessions/:id/notes')
  notes(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: NotesDto) {
    return this.sessions.notes(this.me(u), id, dto.notes);
  }

  @Post('focus/sessions/:id/finish')
  finish(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: FinishDto) {
    return this.sessions.finish(this.me(u), id, dto.outcome, dto.takeBreak === true);
  }

  /** #4787, п. 13: что произошло, пока человек был в фокусе — одной сводкой. */
  @Get('focus/sessions/:id/summary')
  summary(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.sessions.summary(this.me(u), id);
  }

  /** «Как продвинулась работа?» — по каждой задаче фокуса. */
  @Post('focus/sessions/:id/outcomes')
  outcomes(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: OutcomesDto) {
    return this.sessions.outcomes(this.me(u), id, dto.results);
  }

  /** «Постучать срочно» в глубокий фокус коллеги. */
  @Post('users/:id/knock')
  knock(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: KnockDto) {
    return this.sessions.knock(this.me(u), id, dto.reason);
  }
}
