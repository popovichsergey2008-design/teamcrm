import { platform, platformKind } from '../platform';
import { apiUrl } from './origin';

/**
 * Запуск приложения или PWA — для учёта установок (ТЗ консолей, §5.3).
 *
 * installation_id — случайный номер этого экземпляра, придуманный здесь же: не железо
 * и не отпечаток устройства. Браузер без установки не считается — это не установка.
 * Раз в сутки или при смене версии: первый запуск, обновления и активные дни сервер
 * выводит сам.
 */
export function pingLaunch(): void {
  try {
    const kind = platformKind();
    const info = platform.info();
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
    const target = kind === 'capacitor' ? (info.os === 'ios' ? 'ios' : 'android') : standalone ? 'pwa' : null;
    if (!target) return;
    const version = (kind === 'capacitor' ? info.nativeVersion : info.bundleVersion) || undefined;
    let id = localStorage.getItem('qevo.iid');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('qevo.iid', id); }
    const day = new Date().toISOString().slice(0, 10);
    const mark = `${day}|${version ?? ''}`;
    if (localStorage.getItem('qevo.iid.sent') === mark) return;
    const access = platform.secureStorage.get('teamcrm.access');
    void fetch(apiUrl('/api/telemetry/launch'), {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', ...(access ? { Authorization: `Bearer ${access}` } : {}) },
      body: JSON.stringify({ installationId: id, platform: target, version, os: osLine(info.os) }),
    }).then((r) => { if (r.ok) localStorage.setItem('qevo.iid.sent', mark); }).catch(() => undefined);
  } catch { /* приватный режим или старый браузер — без учёта */ }
}

/** «Android 14», «iOS», «desktop» — версия ОС из user-agent, если она там есть. */
function osLine(os: string): string {
  const m = /Android\s(\d+)/.exec(navigator.userAgent);
  return m ? `Android ${m[1]}` : os;
}
