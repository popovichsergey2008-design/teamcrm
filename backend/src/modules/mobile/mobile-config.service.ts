import { Injectable, Logger } from '@nestjs/common';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
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
  /** Размер файла и дата выпуска — для страницы раздачи; CI пишет их в latest.json. */
  sizeBytes?: number;
  publishedAt?: string;
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
  private readonly log = new Logger('MobileConfig');
  /** latest.json читается с диска не чаще раза в минуту: он меняется раз в выпуск. */
  private fileCache: { at: number; mtime: number; value: AndroidRelease | null } | null = null;

  constructor(private readonly db: DbService, private readonly platform: PlatformService) {}

  /**
   * Что сейчас выпущено для Android (ТЗ-9, волна 12).
   *
   * Два источника, и порядок важен. CI при выпуске кладёт APK и `latest.json` в каталог
   * раздачи nginx (он смонтирован сюда только для чтения) — это обычный путь, ничьих рук
   * не требует. Настройка платформы `mobile_android_release` — ручной ход техотдела
   * поверх: поднять минимальную версию, объявить обновление обязательным, отозвать
   * выпуск. Если она задана — она главнее файла.
   */
  async androidRelease(): Promise<AndroidRelease | null> {
    const manual = await this.platform.setting<AndroidRelease | null>('mobile_android_release', null);
    if (manual) return manual;
    return this.latestFromFile();
  }

  private async latestFromFile(): Promise<AndroidRelease | null> {
    const dir = process.env.ANDROID_RELEASES_DIR;
    if (!dir) return null;
    const path = join(dir, 'latest.json');
    const now = Date.now();
    if (this.fileCache && now - this.fileCache.at < 60_000) return this.fileCache.value;
    try {
      const mtime = (await stat(path)).mtimeMs;
      if (this.fileCache && this.fileCache.mtime === mtime) {
        this.fileCache.at = now;
        return this.fileCache.value;
      }
      const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<AndroidRelease>;
      const value = raw.latestNative && raw.apkUrl && raw.sha256
        ? {
          latestNative: String(raw.latestNative), minimumNative: String(raw.minimumNative ?? raw.latestNative),
          apkUrl: String(raw.apkUrl), sha256: String(raw.sha256), force: !!raw.force,
          notes: raw.notes ? String(raw.notes) : undefined,
          sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : undefined,
          publishedAt: raw.publishedAt ? String(raw.publishedAt) : undefined,
        }
        : null;
      this.fileCache = { at: now, mtime, value };
      return value;
    } catch (e) {
      // нет файла — выпусков ещё не было; битый файл — не наш повод падать при старте
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`latest.json не прочитан: ${(e as Error).message}`);
      this.fileCache = { at: now, mtime: 0, value: null };
      return null;
    }
  }

  async config(tenantId: string) {
    const [android, bundle, features, org, incident] = await Promise.all([
      this.androidRelease(),
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