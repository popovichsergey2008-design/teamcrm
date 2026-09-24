import { Body, Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { SecurityService } from './security.service';

class RoleDto {
  @IsOptional() @IsString() @MaxLength(32) id?: string;
  @IsOptional() @IsString() @MaxLength(48) code?: string;
  @IsString() @MinLength(2) @MaxLength(64) name!: string;
  @IsObject() permissions!: Record<string, unknown>;
}

class AssignRoleDto {
  @IsOptional() @IsString() @MaxLength(32) roleId?: string | null;
}

class RevealDto {
  @IsString() @IsIn(['phone', 'email', 'telegram', 'contact']) field!: string;
  /** Причина — когда её требует политика компании. */
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

class PolicyDto {
  @IsOptional() @IsIn(['off', 'optional', 'required_for_admins', 'required_for_all']) twoFactor?: string;
  @IsOptional() @IsObject() contacts?: Record<string, unknown>;
  @IsOptional() @IsObject() tasks?: Record<string, unknown>;
  @IsOptional() @IsObject() integrations?: Record<string, unknown>;
}

class OverrideClearDto {
  @IsString() @MaxLength(48) permission!: string;
  @IsOptional() @IsBoolean() allowed?: boolean;
}

/**
 * Центр безопасности (ТЗ «Central Security System»).
 *
 * `GET /security/me` открыт всем сотрудникам: по нему интерфейс понимает, что
 * показывать, — но решение всё равно принимает сервер на каждом действии. Остальное
 * закрыто правом `security.manage`, которое по умолчанию есть только у владельца.
 */
@ApiTags('security')
@ApiBearerAuth()
@Controller('security')
@Roles('owner', 'manager', 'member')
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  /** Мои права и политика компании — этим интерфейс рисует доступное. */
  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return this.security.me(u.tenantId, u.userId);
  }

  @Get('roles')
  roles(@CurrentUser() u: AuthUser) {
    return this.security.roles(u.tenantId, u);
  }

  @Post('roles')
  saveRole(@CurrentUser() u: AuthUser, @Body() dto: RoleDto) {
    return this.security.saveRole(u.tenantId, u, dto);
  }

  @Delete('roles/:id')
  deleteRole(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.security.deleteRole(u.tenantId, u, id);
  }

  @Post('users/:id/role')
  assignRole(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AssignRoleDto) {
    return this.security.assignRole(u.tenantId, u, id, dto.roleId ?? null);
  }

  /** Ограничить конкретного человека: «всё, кроме контактов и интеграций». */
  @Post('users/:id/permissions')
  setOverrides(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.security.setOverrides(u.tenantId, u, id, body);
  }

  @Post('users/:id/permissions/clear')
  clearOverride(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: OverrideClearDto) {
    return this.security.clearOverride(u.tenantId, u, id, dto.permission);
  }

  @Get('policy')
  policy(@CurrentUser() u: AuthUser) {
    return this.security.policyOf(u.tenantId);
  }

  @Post('policy')
  savePolicy(@CurrentUser() u: AuthUser, @Body() dto: PolicyDto) {
    return this.security.savePolicy(u.tenantId, u, dto as Record<string, unknown>);
  }

  @Get('audit')
  audit(@CurrentUser() u: AuthUser, @Query('event') event?: string, @Query('userId') userId?: string) {
    return this.security.auditList(u.tenantId, u, { event, userId });
  }

  /** Кто смотрел контакты — отдельный отчёт (ТЗ, п. 60). */
  @Get('contact-reveals')
  reveals(@CurrentUser() u: AuthUser) {
    return this.security.revealReport(u.tenantId, u);
  }

  /** Контакты клиента: замаскированные значения считает сервер. */
  @Get('clients/:id/contacts')
  contacts(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.security.clientContacts(u.tenantId, u, id);
  }

  /** Раскрыть одно поле: право, причина по политике и запись в журнал. */
  @Post('clients/:id/reveal')
  reveal(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RevealDto, @Req() req: { ip?: string; headers?: Record<string, unknown> }) {
    const device = String(req?.headers?.['x-device-id'] ?? '') || null;
    return this.security.revealContact(u.tenantId, u, id, dto.field, dto.reason ?? null, { ip: req?.ip ?? null, deviceId: device });
  }
}
