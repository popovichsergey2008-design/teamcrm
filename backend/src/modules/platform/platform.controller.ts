import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { CurrentUser } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { PlatformService } from './platform.service';

class StaffDto {
  @IsString() userId!: string;
  /** Дежурит ли сейчас: снятый остаётся в техотделе и не теряет историю. */
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsIn(['admin', 'agent']) role?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) skills?: string[];
  /** Совсем убрать из техотдела. */
  @IsOptional() @IsBoolean() remove?: boolean;
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
  constructor(private readonly platform: PlatformService) {}

  /** Кто я для платформы: по этому фронт решает, показывать ли консоль вообще. */
  @Get('me')
  async me(@CurrentUser() u: AuthUser) {
    const [staff, admin, tenantId] = await Promise.all([
      this.platform.isStaff(u.userId),
      this.platform.isAdmin(u.userId),
      this.platform.tenantId(),
    ]);
    return { staff, admin, configured: !!tenantId };
  }

  /** Техотдел: кто в нём, кто дежурит, кто администратор. */
  @Get('staff')
  async staff(@CurrentUser() u: AuthUser) {
    await this.platform.assertStaff(u.userId);
    const rows = await this.platform.staffAll();
    return rows.map((s) => ({
      userId: s.user_id, name: s.full_name, role: s.role, onDuty: s.active, skills: s.skills ?? [],
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
      active: dto.active, role: dto.role, skills: dto.skills, remove: dto.remove,
    });
    return rows.map((s) => ({
      userId: s.user_id, name: s.full_name, role: s.role, onDuty: s.active, skills: s.skills ?? [],
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
    }));
  }
}
