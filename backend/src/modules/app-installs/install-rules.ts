/**
 * Скачивания и установки (ТЗ консолей, §5.3): разбор того, что прислали nginx и
 * приложение. Чистые функции — под тестами.
 */

export const INSTALL_PLATFORMS = ['android', 'ios', 'pwa', 'desktop'] as const;
export type InstallPlatform = (typeof INSTALL_PLATFORMS)[number];

export interface DownloadHit { file: string; version: string | null; source: 'site' | 'app' | 'direct' }

/**
 * `/app/qevo-1.52.apk?src=site` → файл, версия, источник. Не APK — null: считаем только
 * дистрибутив, а не latest.json и прочее из того же каталога.
 */
export function parseDownload(uri: string): DownloadHit | null {
  const [path, query = ''] = String(uri ?? '').split('?', 2);
  const m = /^\/app\/(qevo-([0-9][0-9A-Za-z.-]{0,30})\.apk)$/.exec(path);
  if (!m) return null;
  const src = new URLSearchParams(query).get('src');
  return { file: m[1], version: m[2], source: src === 'site' || src === 'app' ? src : 'direct' };
}

/** ОС по user-agent — коротко, для разреза «откуда качают». */
export function osOf(ua: string): string | null {
  const s = String(ua ?? '');
  const android = /Android\s([0-9.]+)/.exec(s);
  if (android) return `Android ${android[1].split('.')[0]}`;
  if (/iPhone|iPad|iPod/.test(s)) return 'iOS';
  if (/Windows NT/.test(s)) return 'Windows';
  if (/Mac OS X/.test(s)) return 'macOS';
  if (/Linux/.test(s)) return 'Linux';
  return s ? 'другая' : null;
}

/** Что делать с запуском: первый, обновление версии или просто ещё один день. */
export function launchKind(prev: { version: string | null } | null, version: string | null): 'first_run' | 'update' | 'seen' {
  if (!prev) return 'first_run';
  if (version && prev.version && version !== prev.version) return 'update';
  return 'seen';
}
