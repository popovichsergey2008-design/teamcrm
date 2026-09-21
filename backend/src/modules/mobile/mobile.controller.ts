import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { MobileService } from './mobile.service';

class RegisterDeviceDto {
  @IsString() @MinLength(8) @MaxLength(128) deviceUuid!: string;
  @IsIn(['android', 'ios', 'web']) platform!: 'android' | 'ios' | 'web';
  @IsOptional() @IsString() @MaxLength(160) model?: string;
  @IsOptional() @IsString() @MaxLength(64) osVersion?: string;
  @IsOptional() @IsString() @MaxLength(64) nativeVersion?: string;
  @IsOptional() @IsString() @MaxLength(64) webBundleVersion?: string;
  @IsOptional() @IsString() @MaxLength(4096) pushToken?: string;
}

/**
 * Мобильное приложение: то, чего нет в вебе (ТЗ-9). Остальной API — общий.
 */
@ApiTags('mobile')
@ApiBearerAuth()
@Controller('mobile')
@Roles('owner', 'manager', 'member')
export class MobileController {
  constructor(private readonly mobile: MobileService) {}

  /** Регистрация устройства после входа и при каждом запуске: версии, push-токен, привязка к сессии. */
  @Post('devices')
  register(@CurrentUser() u: AuthUser, @Body() dto: RegisterDeviceDto) {
    return this.mobile.register(u, dto);
  }

  @Get('devices')
  mine(@CurrentUser() u: AuthUser) {
    return this.mobile.mine(u.userId);
  }

  /** Выход с устройства: его сессии отзываются, push больше не приходит. */
  @Delete('devices/:id')
  async revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.mobile.revoke(u.userId, id);
    return { revoked: true };
  }
}