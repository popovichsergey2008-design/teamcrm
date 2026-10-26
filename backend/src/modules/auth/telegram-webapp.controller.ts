import { Body, Controller, Headers, HttpCode, Ip, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../../common/auth/decorators';
import { AppException } from '../../common/http/app-exception';
import { TelegramWebAppService } from './telegram-webapp.service';

class WebAppLoginDto {
  /** Сырая строка Telegram.WebApp.initData — подпись считается по ней как есть. */
  @IsString() @MinLength(1) @MaxLength(8192) initData!: string;
}

/** #4619: вход в Telegram Mini App по подписанной initData. */
@ApiTags('auth')
@Controller()
export class TelegramWebAppController {
  constructor(private readonly webapp: TelegramWebAppService) {}

  @Public()
  @Post('auth/telegram-webapp')
  @HttpCode(200)
  login(@Body() dto: WebAppLoginDto, @Headers('user-agent') ua: string, @Ip() ip: string) {
    if (!this.webapp.allow(ip)) throw new AppException('RATE_LIMITED', 'Слишком часто, попробуйте через минуту');
    return this.webapp.enter(dto.initData, { userAgent: ua?.slice(0, 200), ip });
  }
}
