import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { ManualStatus, PresenceService } from './presence.service';

export class PresenceStatusDto {
  @IsOptional() @IsIn(['busy', 'away', null]) status!: ManualStatus;
}

@ApiTags('presence')
@ApiBearerAuth()
@Controller('presence')
@Roles('owner', 'manager', 'member')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  /** Кто в сети, кого когда видели, кто что о себе поставил — для Chat Bar. */
  @Get()
  snapshot(@CurrentUser() u: AuthUser) {
    return this.presence.snapshot(u.tenantId);
  }

  /** Свой статус: «занят», «отошёл» или ничего. Только руками. */
  @Put('status')
  setStatus(@CurrentUser() u: AuthUser, @Body() dto: PresenceStatusDto) {
    return this.presence.setStatus(u.tenantId, u.userId, dto.status ?? null);
  }
}
