import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import { Public } from '../../common/auth/decorators';
import { AppException } from '../../common/http/app-exception';
import { CurrentPc, PcAuth, PcGuard, PcNeed } from './pc.guard';
import { PcAuthService } from './pc-auth.service';
import { PcRepository } from './pc.repository';
import { PcStatsService } from './pc-stats.service';
import { PcDevService } from './pc-dev.service';
import { PC_APPS, PERIODS, PeriodKey, periodOf, safeTz } from './pc-rules';

class RegisterDto {
  @IsString() @MaxLength(255) email!: string;
  @IsString() @MaxLength(120) name!: string;
  @IsString() @MaxLength(128) password!: string;
  @IsIn(PC_APPS as unknown as string[]) role!: string;
}
class LoginDto {
  @IsString() @MaxLength(255) email!: string;
  @IsString() @MaxLength(128) password!: string;
  @IsIn(PC_APPS as unknown as string[]) app!: string;
  @IsOptional() @IsString() @MaxLength(16) code?: string;
}
class SetupDto {
  @IsString() @MaxLength(2048) token!: string;
  @IsOptional() @IsString() @MaxLength(16) code?: string;
}
class RefreshDto {
  @IsString() @MaxLength(256) refreshToken!: string;
  @IsOptional() @IsIn(PC_APPS as unknown as string[]) app?: string;
}
class StaffDto {
  @IsIn(['pending', 'active', 'blocked']) status!: string;
  @IsArray() @ArrayMaxSize(3) @IsIn(PC_APPS as unknown as string[], { each: true }) roles!: string[];
}
class TestDto { @IsBoolean() isTest!: boolean }
class NoticeDto {
  @IsString() @MaxLength(400) text!: string;
  @Type(() => Number) @IsInt() @Min(5) @Max(7 * 24 * 60) minutes!: number;
  @IsIn(['info', 'warn']) level!: 'info' | 'warn';
}

const meta = (req: Request) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });

/**
 * Вход в консоли платформы. @Public — только для guard'а CRM: у консоли своя проверка,
 * и токен CRM здесь ничего не открывает.
 */
@Public()
@Controller('pc/auth')
export class PcAuthController {
  constructor(private readonly auth: PcAuthService) {}

  @Post('register') @HttpCode(200)
  register(@Body() dto: RegisterDto, @Req() req: Request) { return this.auth.register(dto, meta(req)); }

  @Post('login') @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: Request) { return this.auth.login(dto, meta(req)); }

  @Post('mfa/setup') @HttpCode(200)
  mfaSetup(@Body() dto: SetupDto) { return this.auth.mfaSetup(dto.token); }

  @Post('mfa/enable') @HttpCode(200)
  mfaEnable(@Body() dto: SetupDto, @Req() req: Request) { return this.auth.mfaEnable(dto.token, dto.code ?? '', meta(req)); }

  @Post('refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto) { return this.auth.refresh(dto.refreshToken, dto.app ?? ''); }

  @Post('logout') @HttpCode(200)
  async logout(@Body() dto: RefreshDto) { await this.auth.logout(dto.refreshToken); return { ok: true }; }
}

@Public()
@UseGuards(PcGuard)
@Controller('pc')
export class PcController {
  constructor(
    private readonly auth: PcAuthService,
    private readonly repo: PcRepository,
    private readonly stats: PcStatsService,
    private readonly dev: PcDevService,
  ) {}

  @Get('me') @PcNeed('any')
  me(@CurrentPc() pc: PcAuth) { return this.auth.me(pc); }

  // ── Консоль владельца ──
  @Get('owner/overview') @PcNeed('owner.view')
  overview(@Query('period') period?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('tz') tz?: string) {
    const key = (PERIODS as string[]).includes(period ?? '') ? (period as PeriodKey) : 'month';
    const zone = safeTz(tz);
    let p;
    try { p = periodOf(key, zone, new Date(), { from, to }); } catch { throw AppException.validation('Проверьте даты периода'); }
    return this.stats.overview(p, zone);
  }

  @Get('owner/tenants') @PcNeed('owner.view')
  tenants() { return this.stats.tenants(); }

  @Post('owner/tenants/:id/test') @PcNeed('owner.manage') @HttpCode(200)
  async setTest(@CurrentPc() pc: PcAuth, @Param('id') id: string, @Body() dto: TestDto, @Req() req: Request) {
    if (!(await this.stats.setTest(id, dto.isTest))) throw AppException.notFound('Компания не найдена');
    await this.repo.audit({ accountId: pc.accountId, app: pc.app, action: 'tenant.test', target: id, meta: { isTest: dto.isTest }, ip: req.ip });
    return { ok: true };
  }

  @Get('owner/staff') @PcNeed('staff.manage')
  staff() { return this.repo.staff(); }

  @Post('owner/staff/:id') @PcNeed('staff.manage') @HttpCode(200)
  async setStaff(@CurrentPc() pc: PcAuth, @Param('id') id: string, @Body() dto: StaffDto, @Req() req: Request) {
    const acc = await this.repo.byId(id);
    if (!acc) throw AppException.notFound('Сотрудник не найден');
    const roles = [...new Set(dto.roles)];
    const status = dto.status === 'pending' && roles.length ? 'active' : dto.status;
    const losesOwner = acc.status === 'active' && acc.roles.includes('owner') && (status !== 'active' || !roles.includes('owner'));
    // без владельца консоль некому будет открыть — последнего не снимаем
    if (losesOwner && (await this.repo.activeOwners()) <= 1) throw AppException.conflict('Это последний владелец платформы — сначала назначьте другого');
    await this.repo.setStaff(id, { status, roles }, pc.accountId);
    // отобранная роль или блокировка — сессии этих консолей заканчиваются сразу (§7)
    for (const app of acc.roles) if (status !== 'active' || !roles.includes(app)) await this.repo.revokeAll(id, app);
    await this.repo.audit({
      accountId: pc.accountId, app: pc.app, action: 'staff.update', target: acc.email,
      meta: { from: { status: acc.status, roles: acc.roles }, to: { status, roles } }, ip: req.ip,
    });
    return { ok: true };
  }

  @Get('owner/audit') @PcNeed('owner.view')
  audit(@Query('limit') limit?: string) { return this.repo.auditList(Math.min(500, Math.max(1, Number(limit) || 200))); }

  @Get('owner/notice') @PcNeed('owner.view')
  notice() { return this.stats.notice(); }

  @Post('owner/notice') @PcNeed('owner.manage') @HttpCode(200)
  async setNotice(@CurrentPc() pc: PcAuth, @Body() dto: NoticeDto, @Req() req: Request) {
    const r = await this.stats.setNotice(dto.text, dto.minutes, dto.level);
    await this.repo.audit({ accountId: pc.accountId, app: pc.app, action: 'notice.set', meta: { text: dto.text.slice(0, 120), minutes: dto.minutes }, ip: req.ip });
    return r;
  }

  @Delete('owner/notice') @PcNeed('owner.manage')
  async clearNotice(@CurrentPc() pc: PcAuth, @Req() req: Request) {
    await this.stats.clearNotice();
    await this.repo.audit({ accountId: pc.accountId, app: pc.app, action: 'notice.clear', ip: req.ip });
    return { ok: true };
  }

  // ── Консоль разработчика ──
  @Get('dev/status') @PcNeed('dev.view')
  devStatus() { return this.dev.status(); }
}
