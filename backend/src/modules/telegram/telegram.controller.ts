import { Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { TelegramService } from './telegram.service';

@ApiTags('telegram')
@ApiBearerAuth()
@Controller('me/telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  /** Выдать одноразовый код привязки (любая internal-роль для себя). */
  @Post('link-code')
  linkCode(@CurrentUser() user: AuthUser) {
    return this.telegram.issueLinkCode(user.tenantId, user.userId);
  }
}
