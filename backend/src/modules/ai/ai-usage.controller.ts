import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AiService } from './ai.service';
import { AiSettingsService } from './ai-settings.service';

class AiSettingsDto {
  @IsOptional() @IsString() @MaxLength(200) openaiKey?: string;
  @IsOptional() @IsString() @MaxLength(200) anthropicKey?: string;
  @IsOptional() @IsString() @MaxLength(64) brainModel?: string;
}

/** Мониторинг ИИ-расхода + BYOK-настройки (ключи/модель на арендатора). */
@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
@Roles('owner', 'manager')
export class AiUsageController {
  constructor(
    private readonly ai: AiService,
    private readonly settings: AiSettingsService,
  ) {}

  @Get('usage')
  usage(@CurrentUser() u: AuthUser, @Query('days') days?: string) {
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    return this.ai.usageStats(u.tenantId, d);
  }

  // ── BYOK: ключи и модель (owner) ──
  @Get('settings')
  @Roles('owner')
  getSettings(@CurrentUser() u: AuthUser) {
    return this.settings.get(u.tenantId);
  }

  @Put('settings')
  @Roles('owner')
  saveSettings(@CurrentUser() u: AuthUser, @Body() dto: AiSettingsDto) {
    return this.settings.update(u.tenantId, u.userId, dto);
  }

  @Get('settings/models')
  @Roles('owner')
  models(@CurrentUser() u: AuthUser) {
    return this.settings.listModels(u.tenantId);
  }
}
