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

/** Короткое имя устройства по user-agent: «iPhone · Safari 17», «Компьютер · Edge 141». */
export function describeUserAgent(ua: string): string {
  return deviceModel(ua);
}

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

/** Показанные системные уведомления браузера: прочитанное закрываем (#1531). */
const shown = new Set<{ n: Notification; key: string | null }>();

/*
  #4710: Windows убирает уведомление браузера через ~5 с — заказчик не успевал прочитать.
  Пока вкладка не на виду, уведомление держится, пока его не нажмут или не закроют
  (requireInteraction). Как в Telegram, они встают столбиком — у каждого свой тег, новое
  не затирает прежнее (больше трёх Windows уберёт в Центр уведомлений, Win+N).
  Вернулся в окно сам — системные убираем: всё пришедшее ждёт в «Пропущенных» внутри.
*/
let stickyWatch = false;
let notifySeq = 0;

/*
  #5023: уведомления с путём показываем через service worker (public/notify-sw.js, своя узкая
  область — страницы он не контролирует и запросы не трогает). Так один тег = одно уведомление
  на все вкладки, а щелчок из Центра уведомлений Windows поднимает вкладку и открывает чат.
*/
let swReg: Promise<ServiceWorkerRegistration | null> | null = null;
const swClicks = new Map<string, () => void>();
function notifyWorker(): Promise<ServiceWorkerRegistration | null> {
  if (swReg) return swReg;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return (swReg = Promise.resolve(null));
  swReg = navigator.serviceWorker.register('/notify-sw.js', { scope: '/__qevo-notify/' })
    .then(async (r) => {
      navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
        const d = e.data as { type?: string; path?: string; tag?: string } | null;
        if (d?.type !== 'qevo-notify-open') return;
        const own = d.tag ? swClicks.get(d.tag) : undefined;
        if (d.tag) swClicks.delete(d.tag);
        window.focus();
        if (own) { own(); return; }
        if (d.path && d.path.startsWith('/')) {
          // щёлкнули уведомление другой вкладки — ведём по пути через свой роутер
          window.history.pushState(null, '', d.path);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }
      });
      // активный воркер нужен для showNotification — ждём, пока установится
      if (!r.active) await new Promise<void>((res) => {
        const w = r.installing ?? r.waiting;
        if (!w) { res(); return; }
        w.addEventListener('statechange', () => { if (w.state === 'activated') res(); });
        window.setTimeout(res, 5000);
      });
      return r.active ? r : null;
    })
    .catch(() => null);
  return swReg;
}
function closeStickyOnReturn() {
  if (stickyWatch || typeof document === 'undefined') return;
  stickyWatch = true;
  const close = () => {
    if (document.hidden) return;
    for (const s of [...shown]) {
      if (!s.n.requireInteraction) continue;
      try { s.n.close(); } catch { /* уже закрыто */ }
      shown.delete(s);
    }
    void swReg?.then((r) => r?.getNotifications()).then((list) => list?.forEach((n) => { if (n.requireInteraction) n.close(); })).catch(() => undefined);
  };
  document.addEventListener('visibilitychange', close);
  window.addEventListener('focus', close);
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
    show(title, body, onClick, key, extra) {
      if (notificationPermission() !== 'granted') return;
      try {
        const sticky = document.hidden || !document.hasFocus();
        if (sticky) closeStickyOnReturn();
        if (extra?.path) {
          const tag = extra.tag ?? `qevo-${++notifySeq}`;
          if (onClick) swClicks.set(tag, onClick);
          if (swClicks.size > 200) swClicks.delete(swClicks.keys().next().value as string);
          void notifyWorker().then((r) => {
            if (r) return r.showNotification(title, { body, tag, requireInteraction: sticky, icon: '/icon-192.png', data: { path: extra.path } } as NotificationOptions);
            // воркера нет (старый браузер, не https) — обычное уведомление, как раньше
            const n = new Notification(title, { body, tag, requireInteraction: sticky } as NotificationOptions);
            n.onclick = () => { window.focus(); n.close(); onClick?.(); };
            shown.add({ n, key: key ?? null });
            n.onclose = () => { for (const s of shown) if (s.n === n) shown.delete(s); };
          }).catch(() => undefined);
          return;
        }
        const n = new Notification(title, { body, tag: `qevo-${++notifySeq}`, requireInteraction: sticky } as NotificationOptions);
        n.onclick = () => { window.focus(); n.close(); onClick?.(); };
        shown.add({ n, key: key ?? null });
        n.onclose = () => { for (const s of shown) if (s.n === n) shown.delete(s); };
      } catch { /* некоторые браузеры запрещают конструктор вне service worker */ }
    },
    prune(keep) {
      for (const s of [...shown]) {
        if (keep && s.key && keep.some((k) => k.path === s.key)) continue;
        if (keep && !s.key) continue; // без пути не знаем, о чём оно, — не трогаем
        try { s.n.close(); } catch { /* уже закрыто */ }
        shown.delete(s);
      }
    },
    setBadge(count) {
      // Значок на иконке PWA — там, где браузер это умеет; заголовок вкладки ведёт tab-alert.
      const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      try {
        if (count > 0) void nav.setAppBadge?.(count); else void nav.clearAppBadge?.();
      } catch { /* нет API — нет значка */ }
    },
    pushToken: () => Promise.resolve(null),
    progress: () => undefined,
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
    // В браузере и в PWA приложение не переустанавливают: обновляется сама страница.
    canInstall: () => Promise.resolve(false),
    install: () => Promise.resolve('unsupported' as const),
    requestInstallPermission: () => Promise.resolve(),
    permitted: () => Promise.resolve(false),
    apply: () => Promise.resolve(),
  },

  deepLinks: {
    // В браузере адрес и есть маршрут: отдельных событий «открыли по ссылке» нет.
    onOpen: () => () => undefined,
  },

  haptics: {
    play(kind) {
      try {
        if (typeof navigator.vibrate !== 'function' || !window.matchMedia('(pointer: coarse)').matches) return;
        navigator.vibrate(VIBRATE[kind]);
      } catch { /* вибрация — дополнение */ }
    },
  },
  calls: {
    reportIncoming: () => Promise.resolve(),
    reportEnded: () => Promise.resolve(),
    keepAwake: () => Promise.resolve(),
    // Маршрутом звука в браузере управлять нельзя — выбирает ОС и сам браузер.
    setAudioRoute: () => Promise.resolve(null),
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

/** Узоры вибрации для браузера (мс): коротко — касание, «тук-пауза-тук» — успех. */
const VIBRATE: Record<'light' | 'medium' | 'success' | 'warning' | 'error', number | number[]> = {
  light: 8, medium: 18, success: [10, 60, 14], warning: [20, 80, 20], error: [30, 60, 30, 60, 30],
};
