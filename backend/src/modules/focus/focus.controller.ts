import { Body, Controller, Delete, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { FOCUS_KINDS, FocusService } from './focus.service';

class SetFocusDto {
  @IsIn(FOCUS_KINDS as unknown as string[])
  kind!: string;

  @IsOptional() @IsString() @MaxLength(160)
  note?: string;

  /** 0 или пусто — до отмены руками; сутки — потолок, дальше это уже отпуск */
  @IsOptional() @IsInt() @Min(0) @Max(1440)
  minutes?: number;

  @IsOptional() @IsString()
  taskId?: string;
}

/** Текущий фокус сотрудника: над чем работает и до какого времени. */
@ApiTags('focus')
@ApiBearerAuth()
@Controller('focus')
@Roles('owner', 'manager', 'member')
export class FocusController {
  constructor(private readonly focus: FocusService) {}

  @Get('me')
  mine(@CurrentUser() u: AuthUser) {
    return this.focus.mine(u.tenantId, u.userId);
  }

  @Put('me')
  set(@CurrentUser() u: AuthUser, @Body() dto: SetFocusDto) {
    return this.focus.set(u.tenantId, u.userId, dto);
  }

  @Delete('me')
  clear(@CurrentUser() u: AuthUser) {
    return this.focus.clear(u.tenantId, u.userId);
  }

  /** Кто чем занят прямо сейчас — чтобы не спрашивать «ты свободен?». */
  @Get('team')
  team(@CurrentUser() u: AuthUser) {
    return this.focus.team(u.tenantId);
  }
}
