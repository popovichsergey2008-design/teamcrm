import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { DealsService } from './deals.service';
import { CreateDealDto } from './deals.dto';

@ApiTags('deals')
@ApiBearerAuth()
@Controller('deals')
@Roles('owner', 'manager') // воронка/финансы — не для member/client
export class DealsController {
  constructor(private readonly deals: DealsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.deals.list(user.tenantId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDealDto) {
    return this.deals.create(user.tenantId, dto);
  }

  @Post(':id/convert')
  convert(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.deals.convert(user.tenantId, id);
  }
}
