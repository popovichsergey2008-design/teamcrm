import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../../common/auth/decorators';
import { AuthThrottleService, RULES } from '../auth/auth-throttle.service';
import { AppErrorsService } from './app-errors.service';

class ErrorReportDto {
  @IsIn(['web', 'mobile']) source!: 'web' | 'mobile';
  @IsString() @MaxLength(120) kind!: string;
  @IsString() @MaxLength(2000) message!: string;
  @IsOptional() @IsString() @MaxLength(4000) stack?: string;
  @IsOptional() @IsString() @MaxLength(300) route?: string;
  @IsOptional() @IsString() @MaxLength(64) version?: string;
  @IsOptional() @IsString() @MaxLength(64) clientId?: string;
  @IsOptional() @IsString() @MaxLength(64) requestId?: string;
}

/**
 * Приём ошибок сайта и приложения. Открыт без входа: падает часто как раз экран входа.
 * Кто прислал — только если токен CRM настоящий; иначе ошибка анонимная. Предел по
 * адресу и очистка текста — чтобы ручкой нельзя было ни засыпать базу, ни слить в неё данные.
 */
@Public()
@Controller('telemetry')
export class AppErrorsController {
  constructor(
    private readonly errors: AppErrorsService,
    private readonly throttle: AuthThrottleService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  @Post('error') @HttpCode(204)
  async report(@Body() dto: ErrorReportDto, @Req() req: Request) {
    await this.throttle.hit(RULES.errorReportIp, req.ip);
    let tenantId: string | null = null;
    let userId: string | null = null;
    const h = String(req.headers.authorization ?? '');
    if (h.startsWith('Bearer ')) {
      try {
        const p = this.jwt.verify<{ sub: string; tenantId: string }>(h.slice(7), { secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET') });
        tenantId = p.tenantId ?? null; userId = p.sub ?? null;
      } catch { /* истёкший или чужой токен — ошибка всё равно нужна, просто без автора */ }
    }
    void this.errors.capture({ ...dto, tenantId, userId });
  }
}
