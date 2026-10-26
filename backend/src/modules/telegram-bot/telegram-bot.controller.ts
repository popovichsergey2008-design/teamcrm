import { Body, Controller, Headers, HttpCode, Ip, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { CurrentUser, Public } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { PlatformService } from '../platform/platform.service';
import { TelegramBotService } from './telegram-bot.service';

class TgLoginDto {
  @IsString() @MaxLength(100) code!: string;
}

@ApiTags('telegram')
@Controller()
export class TelegramBotController {
  private readonly log = new Logger('TelegramBot');
  private readonly secret: string | undefined;

  constructor(
    private readonly bot: TelegramBotService,
    private readonly platform: PlatformService,
    config: ConfigService,
  ) {
    this.secret = config.get<string>('TELEGRAM_WEBHOOK_SECRET') || undefined;
    // без секрета вебхук примет обновление от кого угодно — не ломаем прод, но кричим
    if (!this.secret && config.get<string>('TELEGRAM_BOT_TOKEN')) {
      this.log.warn('TELEGRAM_WEBHOOK_SECRET не задан: вебхук бота не проверяет отправителя. Задайте секрет и передайте его в setWebhook (secret_token).');
    }
  }

  /** Вебхук Telegram — публичный, проверяется секретом (если задан). Диспетчер — в TelegramBotService. */
  @Public()
  @Post('telegram/webhook')
  async webhook(@Headers('x-telegram-bot-api-secret-token') secret: string | undefined, @Body() update: any) {
    if (this.secret && secret !== this.secret) throw AppException.unauthorized('Bad webhook secret');
    await this.bot.handle(update);
    return { received: true };
  }

  /** Вход без пароля по ссылке из бота: ?tglogin=<код> → обычная сессия. */
  @Public()
  @Post('auth/telegram-code')
  @HttpCode(201)
  login(@Body() dto: TgLoginDto, @Ip() ip: string, @Headers('user-agent') ua?: string) {
    return this.bot.exchangeLogin(dto.code, { ip, userAgent: ua });
  }

  /**
   * Имя, описание и команды бота (#4619) — вручную, администратор платформы.
   * Аватар и картинку описания Bot API не ставит: их загружают в BotFather.
   */
  @ApiBearerAuth()
  @Post('platform/telegram-bot/profile')
  async profile(@CurrentUser() u: AuthUser) {
    await this.platform.assertAdmin(u.userId);
    return this.bot.setupProfile();
  }
}
