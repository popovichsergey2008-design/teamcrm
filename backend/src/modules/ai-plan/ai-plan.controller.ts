import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { SecurityService } from '../security/security.service';
import { can } from '../security/permissions';
import { AiPlanService } from './ai-plan.service';
import { PlanCode } from './ai-plan.rules';

class SelectDto {
  @IsIn(['AI_BASIC', 'AI_EXTENDED']) plan_code!: PlanCode;
}
class LimitsDto {
  @IsBoolean() hardLimit!: boolean;
}

/**
 * Тариф ИИ организации (ТЗ-33, §67). Возможности (`entitlements`) видны всем
 * сотрудникам — по ним интерфейс прячет то, чего в тарифе нет; расход и тариф —
 * тем, кому дано «видеть тариф», менять — владельцу.
 */
@ApiTags('ai-plan')
@ApiBearerAuth()
@Controller('ai')
@Roles('owner', 'manager', 'member')
export class AiPlanController {
  constructor(private readonly plans: AiPlanService, private readonly security: SecurityService) {}

  @Get('entitlements')
  async entitlements(@CurrentUser() u: AuthUser) {
    const [row, capabilities, perms] = await Promise.all([
      this.plans.row(u.tenantId), this.plans.capabilities(u.tenantId), this.security.permissionsOf(u.tenantId, u.userId),
    ]);
    return {
      plan: row?.plan_code ?? null,
      capabilities,
      // интернет человеку: тариф разрешает И роль не закрыта
      webForMe: capabilities['ai.web_search'] && can(perms, 'ai.web.use'),
    };
  }

  @Get('plan')
  async plan(@CurrentUser() u: AuthUser) {
    await this.security.require(u.tenantId, u.userId, 'ai.billing.view', 'Тариф и расход ИИ видит руководство');
    return this.plans.view(u.tenantId);
  }

  /** Выбор при регистрации (§37) — владелец, один раз. */
  @Post('plan/select')
  async select(@CurrentUser() u: AuthUser, @Body() dto: SelectDto) {
    if (u.role !== 'owner') throw AppException.forbidden('Тариф выбирает владелец организации');
    return this.plans.select(u.tenantId, u.userId, dto.plan_code);
  }

  @Post('plan/downgrade')
  async downgrade(@CurrentUser() u: AuthUser) {
    await this.security.require(u.tenantId, u.userId, 'ai.billing.manage', 'Тариф меняет владелец');
    return this.plans.downgrade(u.tenantId, u.userId);
  }

  /** «Перейти на Расширенный» — заявка вендору: оплаты в продукте пока нет. */
  @Post('plan/upgrade')
  async upgrade(@CurrentUser() u: AuthUser) {
    await this.security.require(u.tenantId, u.userId, 'ai.billing.manage', 'Тариф меняет владелец');
    return this.plans.requestUpgrade(u.tenantId, u.userId);
  }

  @Patch('limits')
  async limits(@CurrentUser() u: AuthUser, @Body() dto: LimitsDto) {
    await this.security.require(u.tenantId, u.userId, 'ai.billing.manage', 'Лимиты ИИ меняет владелец');
    return this.plans.setHardLimit(u.tenantId, u.userId, dto.hardLimit);
  }
}
