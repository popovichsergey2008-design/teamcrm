import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsIn } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { VelocityService } from './velocity.service';

class AvailabilityDto {
  @IsIn(['vacation', 'sick', 'other']) kind!: string;
  @IsDateString() fromDate!: string;
  @IsDateString() toDate!: string;
}

/** Velocity/загрузка/ёмкость — строго internal-роли (не для client; фича №9). */
@ApiTags('velocity')
@ApiBearerAuth()
@Controller('users')
@Roles('owner', 'manager', 'member')
export class VelocityController {
  constructor(private readonly service: VelocityService) {}

  @Get(':id/velocity')
  velocity(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getVelocity(user.tenantId, id);
  }

  @Get(':id/load')
  load(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.getLoad(user.tenantId, id);
  }

  @Get(':id/availability')
  listAvailability(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.listAvailability(user.tenantId, id);
  }

  @Post(':id/availability')
  @Roles('owner', 'manager')
  addAvailability(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AvailabilityDto) {
    return this.service.addAvailability(user.tenantId, id, dto.kind, dto.fromDate, dto.toDate);
  }
}
