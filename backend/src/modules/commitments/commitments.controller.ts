import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { CommitmentsService } from './commitments.service';

/** Обещания (ТЗ-21, §99): мои и данные мне; отметить выполненным или снять. */
@ApiTags('secretary')
@ApiBearerAuth()
@Controller('assistant/commitments')
@Roles('owner', 'manager', 'member')
export class CommitmentsController {
  constructor(private readonly svc: CommitmentsService) {}

  private a(u: AuthUser) {
    return { tenantId: u.tenantId, userId: u.userId, role: u.role };
  }

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.list(this.a(u));
  }

  @Post(':id/fulfilled')
  fulfilled(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.mark(this.a(u), id, 'fulfilled');
  }

  @Post(':id/dismiss')
  dismiss(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.mark(this.a(u), id, 'dismissed');
  }
}
