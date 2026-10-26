import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
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
  ) {}

  // Вебхук Telegram переехал в TelegramBotController (#4619): там диспетчер, дейлик — его ветка.

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
