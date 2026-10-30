import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { PLATFORM_ROLES, PlatformService, ROLE_TITLES } from './platform.service';
import { AiPlanService } from '../ai-plan/ai-plan.service';
import { BillingService } from '../billing/billing.service';

class BillingPlanDto {
  @IsString() @Matches(/^[a-z0-9_-]{2,32}$/) code!: string;
  @IsString() @MaxLength(80) title!: string;
  @IsNumber() @Min(1) priceRub!: number;
  @IsOptional() @IsInt() @Min(1) maxMembers?: number | null;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
class TenantBillingDto {
  /** «Вечный» доступ без оплаты (свои, партнёры, работавшие до оплаты). */
  @IsOptional() @IsBoolean() complimentary?: boolean;
  /** Продлить вручную до даты (ISO) — например, оплатили по счёту. */
  @IsOptional() @IsString() periodEnd?: string;
  @IsOptional() @IsString() plan?: string;
  /** Продлить пробный период до даты (ISO). */
  @IsOptional() @IsString() trialEndsAt?: string;
}

class StaffDto {
  @IsString() userId!: string;
  /** Дежурит ли сейчас: снятый остаётся в техотделе и не теряет историю. */
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsIn(PLATFORM_ROLES) role?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) skills?: string[];
  /** Сколько разговоров тянет одновременно: больше — новые не назначаются. */
  @IsOptional() @IsInt() @Min(1) @Max(50) maxConversations?: number;
  /** Совсем убрать из техотдела. */
  @IsOptional() @IsBoolean() remove?: boolean;
}

/** Тариф ИИ организации — как договорились с клиентом (ТЗ-33: оплаты в продукте пока нет). */
class AiPlanDto {
  @IsIn(['AI_BASIC', 'AI_EXTENDED']) plan!: 'AI_BASIC' | 'AI_EXTENDED';
  @IsIn(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']) status!: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED';
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) webCredits?: number;
  @IsOptional() @IsInt() @Min(1) @Max(365) trialDays?: number;
  @IsOptional() @IsBoolean() hardLimit?: boolean;
}

/**
 * Консоль техотдела: кабинет разработчика продукта.
 *
 * Здесь всё, что относится к вендору, а не к клиентской организации: состав
 * техотдела и список организаций, которые пользуются продуктом. Обращения и их
 * «кухня» живут в `support/desk` — там же, где и переписка, только с проверкой
 * на принадлежность к техотделу.
 *
 * Клиенту этих ручек не видно: каждая начинается с проверки `assertStaff`.
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService, private readonly aiPlans: AiPlanService, private readonly billing: BillingService) {}

  /** Кто я для платформы: по этому фронт решает, что вообще показывать в консоли. */
  @Get('me')
  async me(@CurrentUser() u: AuthUser) {
    const [role, tenantId] = await Promise.all([
      this.platform.roleOf(u.userId),
      this.platform.tenantId(),
    ]);
    return {
      staff: !!role,
      role,
      roleTitle: role ? ROLE_TITLES[role] : null,
      admin: role === 'admin' || role === 'support_admin',
      /** Инженер видит не очередь, а свои эскалации. */
      engineer: role === 'engineer',
      configured: !!tenantId,
    };
  }

  /** Роли техотдела с человеческими названиями — для выбора в консоли. */
  @Get('roles')
  async roles(@CurrentUser() u: AuthUser) {
    await this.platform.assertStaff(u.userId);
    return PLATFORM_ROLES.map((id) => ({ id, title: ROLE_TITLES[id] }));
  }

  /** Техотдел: кто в нём, кто дежурит, кто администратор. */
  @Get('staff')
  async staff(@CurrentUser() u: AuthUser) {
    await this.platform.assertStaff(u.userId);
    const rows = await this.platform.staffAll();
    return rows.map((s) => ({
      userId: s.user_id, name: s.full_name, role: s.role,
      roleTitle: ROLE_TITLES[s.role as keyof typeof ROLE_TITLES] ?? s.role,
      onDuty: s.active, skills: s.skills ?? [], maxConversations: Number(s.max_conversations ?? 5),
    }));
  }

  /** Из кого выбирать: сотрудники платформы с отметкой «уже в техотделе». */
  @Get('staff/candidates')
  async candidates(@CurrentUser() u: AuthUser) {
    await this.platform.assertAdmin(u.userId);
    const rows = await this.platform.candidates();
    return rows.map((c) => ({
      userId: c.id, name: c.full_name, position: c.position,
      inStaff: c.in_staff, role: c.role, onDuty: c.active ?? false,
    }));
  }

  /** Взять в техотдел, снять с дежурства, сделать администратором или убрать. */
  @Post('staff')
  async setStaff(@CurrentUser() u: AuthUser, @Body() dto: StaffDto) {
    const rows = await this.platform.setStaff(u, dto.userId, {
      active: dto.active, role: dto.role, skills: dto.skills,
      maxConversations: dto.maxConversations, remove: dto.remove,
    });
    return rows.map((s) => ({
      userId: s.user_id, name: s.full_name, role: s.role,
      roleTitle: ROLE_TITLES[s.role as keyof typeof ROLE_TITLES] ?? s.role,
      onDuty: s.active, skills: s.skills ?? [], maxConversations: Number(s.max_conversations ?? 5),
    }));
  }

  /** Организации-клиенты: счётчики и активность, без единой строки их содержимого. */
  @Get('tenants')
  async tenants(@CurrentUser() u: AuthUser) {
    await this.platform.assertStaff(u.userId);
    const rows = await this.platform.tenants();
    return rows.map((t) => ({
      id: t.id, name: t.name, people: Number(t.people),
      openConversations: Number(t.open_convs), lastSeenAt: t.last_seen, createdAt: t.created_at,
      aiPlan: t.plan_code ? {
        plan: t.plan_code, status: t.plan_status, trialEndsAt: t.trial_ends_at,
        webCredits: Number(t.web_credits ?? 0), webUsed: Number(t.web_used ?? 0), upgradeRequestedAt: t.upgrade_requested_at,
      } : null,
    }));
  }

  // ── оплата: тарифы и подписки — только администратор техотдела ──

  @Get('billing/plans')
  async billingPlans(@CurrentUser() u: AuthUser) {
    await this.platform.assertAdmin(u.userId);
    return this.billing.plansAll();
  }

  @Post('billing/plans')
  async saveBillingPlan(@CurrentUser() u: AuthUser, @Body() dto: BillingPlanDto) {
    await this.platform.assertAdmin(u.userId);
    return this.billing.savePlan({
      code: dto.code, title: dto.title, priceRub: dto.priceRub, maxMembers: dto.maxMembers ?? null,
      description: dto.description ?? '', sortOrder: dto.sortOrder ?? 0, isActive: dto.isActive ?? true,
    });
  }

  @Get('tenants/:id/billing')
  async tenantBilling(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.platform.assertStaff(u.userId);
    return this.billing.view(id);
  }

  @Post('tenants/:id/billing')
  async setTenantBilling(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: TenantBillingDto) {
    await this.platform.assertAdmin(u.userId);
    const date = (v?: string) => (v ? new Date(v) : undefined);
    return this.billing.setByVendor(id, {
      complimentary: dto.complimentary, periodEnd: date(dto.periodEnd), planCode: dto.plan ?? null, trialEndsAt: date(dto.trialEndsAt),
    });
  }

  /** Сменить тариф ИИ организации — только администратор техотдела. */
  @Post('tenants/:id/ai-plan')
  async setAiPlan(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AiPlanDto) {
    await this.platform.assertAdmin(u.userId);
    await this.aiPlans.setByVendor(id, u.userId, dto);
    return this.aiPlans.view(id);
  }
}
