import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { PlatformService } from '../platform/platform.service';

/** Что сервер знает о выпущенном Android-приложении: раздача с сайта, а не из магазина (D-03). */
export interface AndroidRelease {
  latestNative: string;
  minimumNative: string;
  apkUrl: string;
  sha256: string;
  /** Обновление обязательное: ниже минимума приложение не работает, только «скачать». */
  force: boolean;
  notes?: string;
}

/** Веб-бандл для OTA внутри оболочки: версия, совместимость с оболочкой, где взять, хэш. */
export interface BundleRelease {
  version: string;
  minNative: string;
  url: string;
  sha256: string;
  mandatory: boolean;
}

export type PushPrivacy = 'hide' | 'sender_only' | 'full';
export type LockPolicy = 'off' | 'immediately' | '1' | '5' | '15';

const FEATURE_DEFAULTS: Record<string, boolean> = {
  mobile_tasks: true, mobile_chat: true, mobile_calls: true, mobile_ai: true,
  mobile_support: true, mobile_offline_v2: false, mobile_widgets: false,
};

/**
 * Конфигурация мобильного клиента (ТЗ-9, волна 4).
 *
 * Одним ответом при старте: версии и обязательность обновления, флаги функций
 * (рискованное выключается с сервера без новой сборки), политика приватности push и
 * блокировки организации, открытая авария. Настройки платформы — в `platform_settings`
 * (правит техотдел из консоли), политика организации — в `tenants` (правит владелец).
 */
@Injectable()
export class MobileConfigService {
  constructor(private readonly db: DbService, private readonly platform: PlatformService) {}

  async config(tenantId: string) {
    const [android, bundle, features, org, incident] = await Promise.all([
      this.platform.setting<AndroidRelease | null>('mobile_android_release', null),
      this.platform.setting<BundleRelease | null>('mobile_bundle', null),
      this.platform.setting<Record<string, boolean>>('mobile_features', {}),
      this.orgPolicy(tenantId),
      this.db.one<{ id: string; title: string; message: string }>(
        `SELECT id::text, title, message FROM support_incidents WHERE status='open' ORDER BY started_at DESC LIMIT 1`,
      ).catch(() => null),
    ]);
    return {
      android,
      bundle,
      features: { ...FEATURE_DEFAULTS, ...features },
      privacy: { push: org.pushPrivacy },
      biometrics: { minLockPolicy: org.minLockPolicy },
      incident: incident ? { id: incident.id, title: incident.title, message: incident.message } : null,
      serverTime: new Date().toISOString(),
    };
  }

  async orgPolicy(tenantId: string): Promise<{ pushPrivacy: PushPrivacy; minLockPolicy: LockPolicy }> {
    const row = await this.db.one<{ push_privacy: string; min_lock_policy: string | null }>(
      `SELECT push_privacy, min_lock_policy FROM tenants WHERE id=$1`, [tenantId],
    );
    const pp = row?.push_privacy;
    const lp = row?.min_lock_policy;
    return {
      pushPrivacy: pp === 'hide' || pp === 'full' ? pp : 'sender_only',
      minLockPolicy: lp === 'immediately' || lp === '1' || lp === '5' || lp === '15' ? lp : 'off',
    };
  }

  /** Владелец: приватность push и нижняя граница блокировки для своей организации. */
  async setOrgPolicy(tenantId: string, role: string, next: { pushPrivacy?: string; minLockPolicy?: string }) {
    if (role !== 'owner') throw AppException.forbidden('Политику безопасности меняет владелец');
    const pp = next.pushPrivacy;
    const lp = next.minLockPolicy;
    if (pp !== undefined && !['hide', 'sender_only', 'full'].includes(pp)) throw AppException.validation('Неизвестная политика push');
    if (lp !== undefined && !['off', 'immediately', '1', '5', '15'].includes(lp)) throw AppException.validation('Неизвестная политика блокировки');
    await this.db.query(
      `UPDATE tenants SET push_privacy = COALESCE($2, push_privacy), min_lock_policy = COALESCE($3, min_lock_policy) WHERE id=$1`,
      [tenantId, pp ?? null, lp ?? null],
    );
    return this.orgPolicy(tenantId);
  }

  // ── техотдел платформы: выпуски ──
  private async assertPlatformAdmin(userId: string): Promise<void> {
    if (!(await this.platform.canManage(userId))) throw AppException.forbidden('Выпуски публикует техотдел');
  }

  async setAndroidRelease(userId: string, r: AndroidRelease) {
    await this.assertPlatformAdmin(userId);
    await this.platform.setSetting('mobile_android_release', r, userId);
    return r;
  }

  async setBundle(userId: string, r: BundleRelease) {
    await this.assertPlatformAdmin(userId);
    await this.platform.setSetting('mobile_bundle', r, userId);
    return r;
  }

  async setFeatures(userId: string, flags: Record<string, boolean>) {
    await this.assertPlatformAdmin(userId);
    const clean: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(flags)) if (/^mobile_[a-z0-9_]{1,40}$/.test(k)) clean[k] = !!v;
    await this.platform.setSetting('mobile_features', clean, userId);
    return { ...FEATURE_DEFAULTS, ...clean };
  }
}