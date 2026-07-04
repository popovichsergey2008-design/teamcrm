import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AiService } from './ai.service';

/** Мониторинг ИИ-расхода (метеринг): вызовы, доля cache-hit, токены. */
@ApiTags('ai')
@ApiBearerAuth()
@Controller('ai')
@Roles('owner', 'manager')
export class AiUsageController {
  constructor(private readonly ai: AiService) {}

  @Get('usage')
  usage(@CurrentUser() u: AuthUser, @Query('days') days?: string) {
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    return this.ai.usageStats(u.tenantId, d);
  }
}
