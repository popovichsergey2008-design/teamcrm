import { Body, Controller, Get, HttpCode, Logger, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { BillingService } from './billing.service';

class CheckoutDto {
  @IsString() @MaxLength(32) plan!: string;
}
class AutopayDto {
  @IsBoolean() on!: boolean;
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  private readonly log = new Logger('BillingWebhook');

  constructor(private readonly billing: BillingService) {}

  /** Состояние подписки — видят все: сотруднику надо знать, почему «только чтение». */
  @ApiBearerAuth()
  @Get()
  view(@CurrentUser() u: AuthUser) {
    return this.billing.view(u.tenantId);
  }

  /** Платит владелец. */
  @ApiBearerAuth()
  @Post('checkout')
  @Roles('owner')
  @HttpCode(200)
  checkout(@CurrentUser() u: AuthUser, @Body() dto: CheckoutDto) {
    return this.billing.checkout(u.tenantId, u.userId, dto.plan);
  }

  /** Вернулся со страницы ЮKassa: сверить платёж сразу, не дожидаясь уведомления. */
  @ApiBearerAuth()
  @Post('payments/:id/check')
  @HttpCode(200)
  check(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.billing.afterReturn(u.tenantId, id);
  }

  @ApiBearerAuth()
  @Post('autopay')
  @Roles('owner')
  @HttpCode(200)
  autopay(@CurrentUser() u: AuthUser, @Body() dto: AutopayDto) {
    return this.billing.setAutopay(u.tenantId, dto.on);
  }

  /**
   * Уведомления ЮKassa (адрес указывается в кабинете ЮKassa → Интеграция → HTTP-уведомления:
   * https://app.qevo.one/api/billing/yookassa/webhook). Отвечаем 200 всегда, кроме сбоя
   * у нас: на не-200 ЮKassa повторяет уведомление ещё сутки — это и нужно при сбое.
   */
  @Public()
  @Post('yookassa/webhook')
  @HttpCode(200)
  async webhook(@Body() body: Record<string, any>) {
    const result = await this.billing.webhook(body);
    if (result !== 'duplicate' && result !== 'ignored') this.log.log(`${body?.event}: ${result}`);
    return { ok: true };
  }
}
