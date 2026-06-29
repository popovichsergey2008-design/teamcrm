import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { TimeTrackingService } from './timetracking.service';

@ApiTags('timetracking')
@ApiBearerAuth()
@Controller()
@Roles('owner', 'manager', 'member') // клиенты не трекают время
export class TimeTrackingController {
  constructor(private readonly service: TimeTrackingService) {}

  @Post('tasks/:id/timer/start')
  start(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.start(user.tenantId, user.userId, id);
  }

  @Post('tasks/:id/timer/stop')
  stop(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.stop(user.tenantId, user.userId, id);
  }

  @Get('me/timer')
  active(@CurrentUser() user: AuthUser) {
    return this.service.active(user.tenantId, user.userId);
  }
}
