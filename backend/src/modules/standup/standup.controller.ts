import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { StandupRepository } from './standup.repository';
import { StandupService } from './standup.service';

class ScheduleDto {
  @IsString() cronExpr!: string;
  @IsString() timezone!: string;
  @IsString() promptText!: string;
  @IsOptional() @IsString() targetRole?: string;
}

@ApiTags('standup')
@Controller()
export class StandupController {
  constructor(
    private readonly service: StandupService,
    private readonly repo: StandupRepository,
    private readonly config: ConfigService,
  ) {}

  /** Telegram webhook — публичный, верифицируется secret token (если задан). */
  @Public()
  @Post('telegram/webhook')
  async webhook(@Headers('x-telegram-bot-api-secret-token') secret: string | undefined, @Body() update: any) {
    const expected = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    if (expected && secret !== expected) throw AppException.unauthorized('Bad webhook secret');
    await this.service.handleTelegramUpdate(update);
    return { received: true };
  }

  @ApiBearerAuth()
  @Get('standup/submissions')
  @Roles('owner', 'manager', 'member')
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.tenantId);
  }

  @ApiBearerAuth()
  @Get('standup/submissions/:id')
  @Roles('owner', 'manager', 'member')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.detail(user.tenantId, id, user.userId);
  }

  @ApiBearerAuth()
  @Post('standup/submissions/:id/confirm')
  @Roles('owner', 'manager', 'member')
  confirm(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.confirm(user.tenantId, id, user.userId);
  }

  @ApiBearerAuth()
  @Post('standup/submissions/:id/undo')
  @Roles('owner', 'manager', 'member')
  undo(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.undo(user.tenantId, id, user.userId);
  }

  @ApiBearerAuth()
  @Get('standup/schedules')
  @Roles('owner', 'manager')
  schedules(@CurrentUser() user: AuthUser) {
    return this.repo.listSchedules(user.tenantId);
  }

  @ApiBearerAuth()
  @Post('standup/schedules')
  @Roles('owner', 'manager')
  createSchedule(@CurrentUser() user: AuthUser, @Body() dto: ScheduleDto) {
    return this.repo.createSchedule({
      tenantId: user.tenantId,
      cronExpr: dto.cronExpr,
      timezone: dto.timezone,
      promptText: dto.promptText,
      targetRole: dto.targetRole ?? null,
    });
  }
}
