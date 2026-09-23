import { Body, Controller, Delete, Get, Ip, Logger, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { MobileConfigService } from './mobile-config.service';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { MobileService } from './mobile.service';
import { DiagService } from '../diagnostics/diag.service';

class ReadDto {
  @IsString() upTo!: string;
}
class ListQuery {
  @IsOptional() @IsString() after?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
class DeviceStateDto {
  @IsBoolean() foreground!: boolean;
}

class CrashDto {
  @IsString() @MaxLength(40) appVersion!: string;
  @IsOptional() @IsString() @MaxLength(120) device?: string;
  @IsOptional() @IsString() @MaxLength(40) os?: string;
  @IsString() @MaxLength(16_000) stack!: string;
  @IsOptional() @IsString() @MaxLength(40) at?: string;
}
class SyncQuery {
  @IsOptional() @IsString() @MaxLength(20) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}
class OrgPolicyDto {
  @IsOptional() @IsIn(['hide', 'sender_only', 'full']) pushPrivacy?: string;
  @IsOptional() @IsIn(['off', 'immediately', '1', '5', '15']) minLockPolicy?: string;
}
class AndroidReleaseDto {
  @IsString() @MaxLength(32) latestNative!: string;
  @IsString() @MaxLength(32) minimumNative!: string;
  @IsString() @MaxLength(500) apkUrl!: string;
  @IsString() @MaxLength(80) sha256!: string;
  @IsBoolean() force!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsInt() @Min(0) sizeBytes?: number;
  @IsOptional() @IsString() @MaxLength(40) publishedAt?: string;
}
class BundleDto {
  @IsString() @MaxLength(64) version!: string;
  @IsString() @MaxLength(32) minNative!: string;
  @IsString() @MaxLength(500) url!: string;
  @IsString() @MaxLength(80) sha256!: string;
  @IsBoolean() mandatory!: boolean;
}
class FeaturesDto {
  @IsObject() flags!: Record<string, boolean>;
}

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
  private readonly log = new Logger('MobileCrash');
  /** Отчёты о падениях — не чаще десяти в минуту с адреса: ручка открытая. */
  private readonly crashHits = new Map<string, { n: number; since: number }>();

  constructor(private readonly mobile: MobileService, private readonly cfg: MobileConfigService, private readonly diag: DiagService) {}

  /**
   * Падение нативной оболочки (ТЗ-9, волна 12).
   *
   * Приложение закрылось при запуске — до входа и до того, как заработал JS. Единственный
   * свидетель — сам процесс в последнюю секунду жизни: обработчик исключений в оболочке
   * шлёт сюда стек до того, как умрёт. Без входа, потому что падение бывает и до него.
   * Ложится в ленту диагностики (scope `app`, ref = версия) и в журнал сервера.
   */
  @Public()
  @Post('crash')
  crash(@Ip() ip: string, @Body() dto: CrashDto) {
    const now = Date.now();
    const hit = this.crashHits.get(ip) ?? { n: 0, since: now };
    if (now - hit.since > 60_000) { hit.n = 0; hit.since = now; }
    hit.n += 1;
    this.crashHits.set(ip, hit);
    if (hit.n > 10) return { ok: false };
    const head = dto.stack.split('\n').slice(0, 3).join(' | ');
    this.log.warn(`падение ${dto.appVersion} · ${dto.device ?? '?'} · ${dto.os ?? '?'}: ${head}`);
    this.diag.write({
      scope: 'app', refId: dto.appVersion.slice(0, 64), side: 'client', event: 'crash',
      data: { device: dto.device, os: dto.os, stack: dto.stack }, at: dto.at ?? null,
    });
    return { ok: true };
  }

  /**
   * Страница раздачи «Скачать приложение» — без входа (волна 12): человек ещё не в
   * системе, ему нужны только версия, ссылка на APK и хэш для проверки.
   */
  @Public()
  @Get('release')
  async release() {
    return { android: await this.cfg.androidRelease() };
  }

  /** Всё, что клиенту нужно при старте: версии, флаги, политики, авария. */
  @Get('config')
  config(@CurrentUser() u: AuthUser) {
    return this.cfg.config(u.tenantId);
  }

  /** «Фокус дня» одним ответом: мои, порученные, на проверке, согласования. */
  @Get('focus')
  focus(@CurrentUser() u: AuthUser) {
    return this.mobile.focus(u.tenantId, u.userId);
  }

  /** Ящик уведомлений: после курсора — или последние, если курсора ещё нет. */
  @Get('notifications')
  notifications(@CurrentUser() u: AuthUser, @Query() q: ListQuery) {
    return this.mobile.notifications(u.userId, q.after ?? null, q.limit ?? 50);
  }

  /** Delta-sync: ссылки на изменившееся после курсора (волна 9). */
  @Get('sync')
  sync(@CurrentUser() u: AuthUser, @Query() q: SyncQuery) {
    const cursor = q.cursor && /^\d{1,18}$/.test(q.cursor) ? q.cursor : null;
    return this.mobile.sync(u, cursor, q.limit ?? 200);
  }

  @Post('notifications/read')
  async read(@CurrentUser() u: AuthUser, @Body() dto: ReadDto) {
    await this.mobile.markRead(u.userId, dto.upTo);
    return { ok: true };
  }

  /** Политика организации: приватность push и нижняя граница блокировки (читают все, меняет владелец). */
  @Get('org-policy')
  orgPolicy(@CurrentUser() u: AuthUser) {
    return this.cfg.orgPolicy(u.tenantId);
  }

  @Post('org-policy')
  setOrgPolicy(@CurrentUser() u: AuthUser, @Body() dto: OrgPolicyDto) {
    return this.cfg.setOrgPolicy(u.tenantId, u.role, dto);
  }

  // ── выпуски — техотдел платформы ──
  @Post('admin/android-release')
  setAndroid(@CurrentUser() u: AuthUser, @Body() dto: AndroidReleaseDto) {
    return this.cfg.setAndroidRelease(u.userId, dto);
  }

  @Post('admin/bundle')
  setBundle(@CurrentUser() u: AuthUser, @Body() dto: BundleDto) {
    return this.cfg.setBundle(u.userId, dto);
  }

  @Post('admin/features')
  setFeatures(@CurrentUser() u: AuthUser, @Body() dto: FeaturesDto) {
    return this.cfg.setFeatures(u.userId, dto.flags);
  }

  /** Регистрация устройства после входа и при каждом запуске: версии, push-токен, привязка к сессии. */
  @Post('devices')
  register(@CurrentUser() u: AuthUser, @Body() dto: RegisterDeviceDto) {
    return this.mobile.register(u, dto);
  }

  /**
   * Оболочка сообщает, открыта она или свёрнута (исправление «push не приходит»).
   *
   * По этому признаку сервер решает, нужен ли push ИМЕННО этому телефону: человек,
   * который смотрит в экран, уже видит сообщение, всем остальным устройствам оно нужно.
   */
  @Post('devices/:id/state')
  deviceState(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DeviceStateDto) {
    return this.mobile.setDeviceState(u.userId, id, dto.foreground === true);
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