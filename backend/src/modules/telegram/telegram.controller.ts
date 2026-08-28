import { Controller, Delete, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { TelegramService } from './telegram.service';

@ApiTags('telegram')
@ApiBearerAuth()
@Controller('me/telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  /**
   * Привязан ли Telegram. Нужно самому человеку: в чат дублируются уведомления
   * с почты, и без этой отметки непонятно, придут они или нет.
   */
  @Get('status')
  async status(@CurrentUser() user: AuthUser) {
    const chatId = await this.telegram.chatIdOf(user.tenantId, user.userId);
    return { linked: !!chatId };
  }

  /** Выдать одноразовый код привязки (любая internal-роль для себя). */
  @Post('link-code')
  linkCode(@CurrentUser() user: AuthUser) {
    return this.telegram.issueLinkCode(user.tenantId, user.userId);
  }

  /** Отвязать свой Telegram: сменил аккаунт, отдал телефон, просто больше не хочет. */
  @Delete('link')
  async unlink(@CurrentUser() user: AuthUser) {
    await this.telegram.unlink(user.tenantId, user.userId);
    return { ok: true };
  }
}
