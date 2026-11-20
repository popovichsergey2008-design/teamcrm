import { Body, Controller, Get, HttpCode, Logger, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { BillingService } from './billing.service';
import { TrialLimitsService } from './trial-limits.service';

class CheckoutDto {
  @IsString() @MaxLength(32) plan!: string;
  @IsOptional() @IsIn(['month', 'year']) period?: 'month' | 'year';
  /** 19.11.2026: срок в месяцах (1–12); 12 — год со скидкой. Есть — главнее period. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12) months?: number;
  /** #5000: за сколько пользователей платим — не меньше, чем сейчас в команде. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) seats?: number;
}
class AutopayDto {
  @IsBoolean() on!: boolean;
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  private readonly log = new Logger('BillingWebhook');

  constructor(private readonly billing: BillingService, private readonly limits: TrialLimitsService) {}

  /** Состояние подписки — видят все: сотруднику надо знать, почему «только чтение». */
  @ApiBearerAuth()
  @Get()
  view(@CurrentUser() u: AuthUser) {
    return this.billing.view(u.tenantId);
  }

  /** #4779, п. 4: лимиты пробного периода — созвон с ИИ и задачи голосом. Видят все. */
  @ApiBearerAuth()
  @Get('trial-limits')
  trialLimits(@CurrentUser() u: AuthUser) {
    return this.limits.view(u.tenantId);
  }

  /** Платит владелец. */
  @ApiBearerAuth()
  @Post('checkout')
  @Roles('owner')
  @HttpCode(200)
  checkout(@CurrentUser() u: AuthUser, @Body() dto: CheckoutDto) {
    return this.billing.checkout(u.tenantId, u.userId, dto.plan, dto.period ?? 'month', dto.months, dto.seats);
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
