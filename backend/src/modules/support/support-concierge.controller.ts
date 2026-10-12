import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { MANUAL_STATUSES } from './support-concierge';
import { SupportConciergeService } from './support-concierge.service';
import { SupportDeskService } from './support-desk.service';

class StatusDto {
  @IsIn(MANUAL_STATUSES as unknown as string[]) status!: 'available' | 'busy' | 'away';
}
class ShiftDto {
  @IsString() userId!: string;
  @IsISO8601() startsAt!: string;
  @IsISO8601() endsAt!: string;
}
class AllowDto {
  @IsBoolean() allow!: boolean;
}
class WorksDto {
  @IsBoolean() works!: boolean;
}
class AccessRequestDto {
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
class AccessDecisionDto {
  @IsBoolean() allow!: boolean;
  @IsOptional() @IsString() projectId?: string;
}

/**
 * Консьерж-поддержка (ТЗ-29, п. 39–43): статус инженеров и ожидание, смены, обратный
 * звонок, согласие на запись, итог помощи, доступ на 15 минут. Разговор — тот же, что
 * в «Службе заботы»; организация разговора определяется тем же `deskTenant`.
 */
@ApiTags('support')
@ApiBearerAuth()
@Controller('support/desk')
@Roles('owner', 'manager', 'member')
export class SupportConciergeController {
  constructor(private readonly concierge: SupportConciergeService, private readonly desk: SupportDeskService) {}

  /** Кто на связи и сколько ждать — для панели помощи. */
  @Get('concierge')
  availability() {
    return this.concierge.availability();
  }

  @Patch('concierge/me')
  setStatus(@CurrentUser() u: AuthUser, @Body() dto: StatusDto) {
    return this.concierge.setMyStatus(u, dto.status);
  }

  @Get('concierge/shifts')
  shifts(@CurrentUser() u: AuthUser) {
    return this.concierge.shifts(u);
  }

  @Post('concierge/shifts')
  addShift(@CurrentUser() u: AuthUser, @Body() dto: ShiftDto) {
    return this.concierge.addShift(u, dto);
  }

  @Delete('concierge/shifts/:shiftId')
  cancelShift(@CurrentUser() u: AuthUser, @Param('shiftId') shiftId: string) {
    return this.concierge.cancelShift(u, shiftId);
  }

  @Get('concierge/room/:roomId')
  room(@CurrentUser() u: AuthUser, @Param('roomId') roomId: string) {
    return this.concierge.room(u, roomId);
  }

  @Get('concierge/metrics')
  metrics(@CurrentUser() u: AuthUser) {
    return this.concierge.metrics(u);
  }

  /** «Позвать меня, когда инженер освободится». */
  @Get('concierge/callback')
  callbackState(@CurrentUser() u: AuthUser) {
    return this.concierge.callbackState(u);
  }

  @Post('concierge/callback')
  callback(@CurrentUser() u: AuthUser) {
    return this.concierge.callback(u.tenantId, u);
  }

  @Delete('concierge/callback')
  cancelCallback(@CurrentUser() u: AuthUser) {
    return this.concierge.cancelCallback(u);
  }

  @Post(':id/recording')
  async recording(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AllowDto) {
    return this.concierge.recordingConsent(await this.desk.deskTenant(u, id), u, id, dto.allow);
  }

  @Post(':id/resolution')
  async resolution(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: WorksDto) {
    return this.concierge.resolutionFeedback(await this.desk.deskTenant(u, id), u, id, dto.works);
  }

  @Post(':id/offer-test')
  async offerTest(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.concierge.offerTest(await this.desk.deskTenant(u, id), u, id);
  }

  @Get(':id/access')
  async access(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.concierge.accessList(await this.desk.deskTenant(u, id), u, id);
  }

  @Post(':id/access')
  async requestAccess(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AccessRequestDto) {
    return this.concierge.requestAccess(await this.desk.deskTenant(u, id), u, id, dto.reason ?? null);
  }

  @Post(':id/access/:grantId/decide')
  async decide(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('grantId') grantId: string, @Body() dto: AccessDecisionDto) {
    return this.concierge.decideAccess(await this.desk.deskTenant(u, id), u, id, grantId, dto);
  }

  @Post(':id/access/:grantId/revoke')
  async revoke(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('grantId') grantId: string) {
    return this.concierge.revokeAccess(await this.desk.deskTenant(u, id), u, id, grantId);
  }

  /** Настройки проекта глазами инженера — по живому разрешению. */
  @Get(':id/access/:grantId/view')
  async view(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('grantId') grantId: string) {
    return this.concierge.accessView(await this.desk.deskTenant(u, id), u, id, grantId);
  }
}
