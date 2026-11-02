import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { Public } from '../../common/auth/decorators';
import { AuthThrottleService, RULES } from '../auth/auth-throttle.service';
import { AppInstallsService } from './app-installs.service';
import { INSTALL_PLATFORMS } from './install-rules';

class LaunchDto {
  @IsUUID() installationId!: string;
  @IsIn(INSTALL_PLATFORMS as unknown as string[]) platform!: string;
  @IsOptional() @IsString() @MaxLength(40) version?: string;
  @IsOptional() @IsString() @MaxLength(60) os?: string;
  @IsOptional() @IsIn(['stable', 'beta']) channel?: string;
  @IsOptional() @IsString() @MaxLength(32) source?: string;
}

/**
 * Учёт скачиваний и запусков (§5.3). Открыт без входа: первый запуск бывает до
 * регистрации. Компания — только если токен CRM настоящий (чтобы исключать тестовые).
 */
@Public()
@Controller('telemetry')
export class AppInstallsController {
  constructor(
    private readonly installs: AppInstallsService,
    private readonly throttle: AuthThrottleService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Выдача APK — зовёт только nginx-зеркало (`mirror` в /app/*.apk). Признак
   * X-Apk-Hit ставит nginx; из внешних запросов он вычищается в location /api/.
   */
  @Get('download') @HttpCode(204)
  async download(@Req() req: Request) {
    if (req.headers['x-apk-hit'] !== '1' || req.headers['x-original-method'] === 'HEAD') return;
    await this.installs.download(String(req.headers['x-original-uri'] ?? ''), req.ip ?? '', String(req.headers['user-agent'] ?? ''));
  }

  @Post('launch') @HttpCode(204)
  async launch(@Body() dto: LaunchDto, @Req() req: Request) {
    await this.throttle.hit(RULES.launchIp, req.ip);
    let tenantId: string | null = null;
    const h = String(req.headers.authorization ?? '');
    if (h.startsWith('Bearer ')) {
      try { tenantId = this.jwt.verify<{ tenantId: string }>(h.slice(7), { secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET') }).tenantId ?? null; }
      catch { /* истёкший токен — запуск всё равно считаем, без компании */ }
    }
    await this.installs.launch({ ...dto, tenantId });
  }
}
