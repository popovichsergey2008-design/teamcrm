import { Controller, Param, Post, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { CopilotService } from './copilot.service';

@ApiTags('copilot')
@ApiBearerAuth()
@Controller()
@Roles('owner', 'manager', 'member') // client не получает рекомендации (фича №9)
export class CopilotController {
  constructor(private readonly service: CopilotService) {}

  @Get('recommendations')
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user.tenantId, user.role);
  }

  @Post('copilot/scan')
  @Roles('owner', 'manager')
  scan(@CurrentUser() user: AuthUser) {
    return this.service.scan(user.tenantId);
  }

  @Post('recommendations/:id/accept')
  @Roles('owner', 'manager')
  accept(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.accept(user.tenantId, id, user.userId);
  }

  @Post('recommendations/:id/dismiss')
  @Roles('owner', 'manager')
  dismiss(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.dismiss(user.tenantId, id);
  }
}
