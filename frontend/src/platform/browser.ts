import type {
  NotificationPermissionState, PlatformBridge, PlatformInfo, PlatformKind, PlatformOs,
} from './types';

/**
 * Браузерная реализация моста — и запасная для всех остальных.
 *
 * Работает в вебе на компьютере и в PWA на телефоне. Что ОС в браузере не даёт
 * (биометрия, push-токен, обновление оболочки), здесь честно отвечает «нет», а не
 * притворяется: компоненты по этому «нет» прячут кнопку, а не показывают сломанную.
 */

/** Окружение сборки; вне Vite (проверки логики в node) его нет — тогда пусто. */
const env: { VITE_PLATFORM?: string; VITE_BUNDLE_VERSION?: string } =
  (import.meta as { env?: { VITE_PLATFORM?: string; VITE_BUNDLE_VERSION?: string } }).env ?? {};

/** Режим сборки — из окружения Vite; по умолчанию обычный веб. */
export function buildKind(): PlatformKind {
  const raw = String(env.VITE_PLATFORM ?? 'web');
  return raw === 'mobile-web' || raw === 'capacitor' ? raw : 'web';
}

export function detectOs(ua = navigator.userAgent): PlatformOs {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows|Mac OS X|Linux|CrOS/.test(ua)) return 'desktop';
  return 'other';
}

/** Короткое имя устройства для диагностики: «iPhone», «Android · Chrome 141», «Windows · Edge 141». */
function deviceModel(ua = navigator.userAgent): string {
  const browser = /(Edg|OPR|Chrome|Firefox|Safari)\/(\d+)/.exec(ua);
  const b = browser ? `${({ Edg: 'Edge', OPR: 'Opera' } as Record<string, string>)[browser[1]] ?? browser[1]} ${browser[2]}` : 'браузер';
  const os = detectOs(ua);
  return `${os === 'ios' ? 'iPhone' : os === 'android' ? 'Android' : os === 'desktop' ? 'Компьютер' : 'Устройство'} · ${b}`;
}

/** Версия бандла подставляется сборкой; в dev — «dev». */
export const BUNDLE_VERSION = String(env.VITE_BUNDLE_VERSION ?? 'dev');

function notificationPermission(): NotificationPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export const browserBridge: PlatformBridge = {
  info(): PlatformInfo {
    return { kind: buildKind(), os: detectOs(), nativeVersion: null, bundleVersion: BUNDLE_VERSION, model: deviceModel() };
  },
  deviceUuid: () => Promise.resolve(null),

  secureStorage: {
    ready: () => Promise.resolve(),
    get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* приватный режим — сессия проживёт до перезагрузки */ } },
    remove: (key) => { try { localStorage.removeItem(key); } catch { /* нечего удалять */ } },
  },

  notifications: {
    permission: notificationPermission,
    async requestPermission() {
      if (notificationPermission() === 'unsupported') return 'unsupported';
      try { return await Notification.requestPermission(); } catch { return Notification.permission; }
    },
    show(title, body, onClick) {
      if (notificationPermission() !== 'granted') return;
      try {
        const n = new Notification(title, { body, tag: 'teamcrm-chat', renotify: true } as NotificationOptions);
        n.onclick = () => { window.focus(); n.close(); onClick?.(); };
      } catch { /* некоторые браузеры запрещают конструктор вне service worker */ }
    },
    setBadge(count) {
      // Значок на иконке PWA — там, где браузер это умеет; заголовок вкладки ведёт tab-alert.
      const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      try {
        if (count > 0) void nav.setAppBadge?.(count); else void nav.clearAppBadge?.();
      } catch { /* нет API — нет значка */ }
    },
    pushToken: () => Promise.resolve(null),
  },

  biometrics: {
    available: () => Promise.resolve(false),
    authenticate: () => Promise.resolve(false),
  },

  share: {
    canShare: () => typeof navigator !== 'undefined' && typeof navigator.share === 'function',
    async share(data) {
      if (typeof navigator.share !== 'function') return false;
      try { await navigator.share(data); return true; } catch { return false; }
    },
  },

  appUpdate: {
    check: () => Promise.resolve(null),
    apply: () => Promise.resolve(),
  },

  deepLinks: {
    // В браузере адрес и есть маршрут: отдельных событий «открыли по ссылке» нет.
    onOpen: () => () => undefined,
  },

  calls: {
    reportIncoming: () => Promise.resolve(),
    reportEnded: () => Promise.resolve(),
    keepAwake: () => Promise.resolve(),
  },

  filesystem: {
    async save(name, blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  },

  openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
};