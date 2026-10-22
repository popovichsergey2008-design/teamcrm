import { App as CapApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Device } from '@capacitor/device';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { PrivacyScreen } from '@capacitor-community/privacy-screen';
import { PushNotifications } from '@capacitor/push-notifications';
import { ForegroundService, ServiceType } from '@capawesome-team/capacitor-android-foreground-service';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { registerPlugin, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { browserBridge, BUNDLE_VERSION } from './browser';
import { careNotification, shouldFetchBundle, type BundleManifest, type CareProgress } from './native-logic';
import { API_ORIGIN } from '../lib/origin';
import type { PlatformBridge, PlatformInfo } from './types';

/**
 * Мост в ОС для оболочки Capacitor (ТЗ-9, волна 2).
 *
 * Тот же интерфейс, что у браузерной реализации, — компоненты разницы не видят.
 * Что оболочка пока не умеет (push-токен, обновление бандла, системный звонок),
 * наследуется от браузерной версии и честно отвечает «нет»: эти куски приходят в
 * волнах 4 и 7 и заменяются здесь по одному, не трогая компоненты.
 *
 * Файл грузится динамически и только в режиме capacitor (см. main.tsx): в веб-бандл
 * Capacitor не попадает.
 */

/** Токены: чтение синхронное из памяти, запись — в Keychain/Keystore в фоне. */
const cache = new Map<string, string>();
const KEYS = ['teamcrm.access', 'teamcrm.refresh'];

let deviceInfo: PlatformInfo | null = null;

/*
  Push (ТЗ-9, волна 4).

  Токен FCM/APNs приходит событием после `register()`; держим его в обещании, чтобы
  регистрация устройства могла его дождаться. Нажатие на уведомление — тот же путь,
  что deep link (`data.path`); push в открытое приложение — событие в окно, по нему
  ящик догоняется с сервера (сам push — не источник истины).
*/
let pushToken: Promise<string | null> | null = null;
const deepLinkHandlers = new Set<(path: string) => void>();

/*
  Уведомления самого приложения (волна 12).

  Push через Firebase будит закрытое приложение, но Firebase у нас пока нет. Пока
  процесс жив — открыт или свёрнут — события приходят по сокету, и показать их в
  центре уведомлений ОС можно без всякого Firebase: `LocalNotifications`. Браузерный
  `new Notification()` в WebView не работает вовсе — поэтому в оболочке молчало всё.
  Разрешение кэшируем: интерфейс моста читает его синхронно.
*/
type Perm = 'granted' | 'denied' | 'default' | 'unsupported';
let localPerm: Perm = 'default';
let nextLocalId = 1;
const clickHandlers = new Map<number, () => void>();
/** Локальные уведомления в шторке → путь записи ящика: прочитанное убираем (#1531). */
const localKeys = new Map<number, string | null>();
const CALL_NOTIFICATION_ID = 900_001;

function toPerm(v: string | undefined): Perm {
  return v === 'granted' ? 'granted' : v === 'denied' ? 'denied' : 'default';
}
async function prepareLocalNotifications(): Promise<void> {
  try {
    localPerm = toPerm((await LocalNotifications.checkPermissions()).display);
    await LocalNotifications.createChannel({ id: 'anthill', name: 'QEVO', importance: 4, sound: 'default', description: 'Сообщения, задачи, напоминания' });
    await LocalNotifications.createChannel({ id: 'anthill-calls', name: 'Звонки', importance: 5, sound: 'default', vibration: true, description: 'Входящие созвоны' });
    await LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
      const h = clickHandlers.get(e.notification.id);
      clickHandlers.delete(e.notification.id);
      if (h) h();
      else if (e.notification.id === CALL_NOTIFICATION_ID) for (const d of deepLinkHandlers) d('/chat');
    });
  } catch { /* старый WebView или iOS без разрешения */ }
}

/** Свой плагин оболочки (native/android/.../AnthillNativePlugin.java). */
const AnthillNative = registerPlugin<{
  pushAvailable(): Promise<{ available: boolean }>;
  canInstall(): Promise<{ supported: boolean; allowed: boolean }>;
  requestInstallPermission(): Promise<void>;
  installUpdate(o: { url: string; sha256: string; version: string }): Promise<{ status: string; message?: string }>;
  setAudioRoute(o: { route: string }): Promise<{ route: string }>;
  bundleStatus(): Promise<{ native: string; stable?: string; trial?: string; pending?: string; bad: string[] }>;
  bundleDownload(o: BundleManifest): Promise<{ status: string; message?: string }>;
  bundleApply(): Promise<{ applied: boolean }>;
  bundleReady(o: { version: string }): Promise<{ confirmed: boolean }>;
  careProgress(o: { title?: string; text?: string; percent?: number; done?: boolean; clear?: boolean }): Promise<{ shown: boolean }>;
  addListener(
    event: 'updateProgress',
    cb: (e: { loaded: number; total: number }) => void,
  ): Promise<{ remove(): Promise<void> }>;
}>('AnthillNative');

/*
  Обновление приложения изнутри (просьба заказчика).

  Магазинов у нас нет намеренно, и раньше обновление означало: открыть браузер, скачать
  APK, найти его в загрузках, разрешить установку, нажать. Люди застревали на этом пути и
  оставались на старой сборке. Теперь оболочка качает файл сама, сверяет с контрольной
  суммой из latest.json и отдаёт системному установщику — остаётся одно нажатие.

  Ставит всё равно система и показывает, что именно ставится: молча подменить приложение
  ни мы, ни кто-либо другой не можем.
*/
async function installUpdate(
  release: { url: string; sha256: string; version: string },
  onProgress?: (share: number) => void,
): Promise<'installing' | 'needs_permission' | 'unsupported' | 'failed'> {
  let watch: { remove(): Promise<void> } | null = null;
  try {
    const can = await AnthillNative.canInstall().catch(() => ({ supported: false, allowed: false }));
    if (!can.supported) return 'unsupported';
    if (onProgress) {
      watch = await AnthillNative.addListener('updateProgress', (e) => {
        if (e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
      });
    }
    const r = await AnthillNative.installUpdate(release);
    const status = r?.status;
    return status === 'installing' || status === 'needs_permission' ? status : 'failed';
  } catch {
    return 'failed';
  } finally {
    await watch?.remove().catch(() => undefined);
  }
}

/*
  Обновление веб-части по воздуху (ТЗ-34, этап D) — только Android-оболочка.

  Сервер отдаёт манифест (`/mobile/bundle?native=…`), оболочка сама качает zip, сверяет
  sha256 и подпись, распаковывает и применяет со следующего запуска или когда приложение
  уходит в фон (не посреди созвона). Новый бандл обязан сказать «живой» (`bundleReady`)
  за 15 с, иначе оболочка вернёт прежний и больше этот не поставит (BundleUpdater.java).
  Старая оболочка без этих методов отвечает ошибкой — тогда всё молча выключено.
*/
const OTA_EVERY_MS = 30 * 60_000;
/** Куда вернуться после перезагрузки на новый бандл: WebView откроется с корня. */
const OTA_RESUME_KEY = 'qevo.ota.resume';
let callActive = false;
let otaRun: Promise<{ version: string; mandatory: boolean } | null> | null = null;

function otaCheck(): Promise<{ version: string; mandatory: boolean } | null> {
  if (otaRun) return otaRun;
  otaRun = (async () => {
    try {
      if (deviceInfo?.os !== 'android') return null;
      const st = await AnthillNative.bundleStatus();
      const res = await fetch(`${API_ORIGIN}/api/mobile/bundle?native=${encodeURIComponent(st.native)}`);
      const m = ((await res.json()) as { data?: { bundle?: BundleManifest | null } })?.data?.bundle ?? null;
      if (!m) return null;
      const already = st.pending === m.version;
      if (!already && !shouldFetchBundle(m, { running: BUNDLE_VERSION, native: st.native, bad: st.bad ?? [], pending: st.pending ?? null, stable: st.stable ?? null })) return null;
      const r = already ? { status: 'ready' } : await AnthillNative.bundleDownload(m);
      return r.status === 'ready' ? { version: m.version, mandatory: !!m.mandatory } : null;
    } catch { return null; } finally { otaRun = null; }
  })();
  return otaRun;
}

async function otaApply(): Promise<boolean> {
  try {
    if (!(await AnthillNative.bundleStatus()).pending) return false;
    try { localStorage.setItem(OTA_RESUME_KEY, JSON.stringify({ path: `${location.pathname}${location.search}`, at: Date.now() })); } catch { /* без возврата — откроется главная */ }
    const { applied } = await AnthillNative.bundleApply();
    if (!applied) try { localStorage.removeItem(OTA_RESUME_KEY); } catch { /* не страшно */ }
    return applied;
  } catch { return false; }
}

/** Бандл поднялся и нарисовал экран — сказать оболочке «живой». */
function confirmAlive(): void {
  const started = Date.now();
  const tick = () => {
    if (document.getElementById('root')?.childElementCount) {
      // полторы секунды на то, чтобы упасть сразу после первой отрисовки
      setTimeout(() => {
        if (document.getElementById('root')?.childElementCount) void AnthillNative.bundleReady({ version: BUNDLE_VERSION }).catch(() => undefined);
      }, 1500);
      return;
    }
    if (Date.now() - started < 14_000) setTimeout(tick, 250);
  };
  tick();
}

function startOta(): void {
  if (deviceInfo?.os !== 'android') return;
  // вернуть человека туда, где он был до перезагрузки на новый бандл
  try {
    const saved = JSON.parse(localStorage.getItem(OTA_RESUME_KEY) ?? 'null') as { path?: string; at?: number } | null;
    localStorage.removeItem(OTA_RESUME_KEY);
    if (saved?.path?.startsWith('/') && !saved.path.startsWith('//') && Date.now() - (saved.at ?? 0) < 6 * 3600_000) {
      history.replaceState(history.state, '', saved.path);
    }
  } catch { /* нет хранилища — откроется главная */ }
  confirmAlive();
  setTimeout(() => void otaCheck(), 20_000); // после стартовых запросов, не вместе с ними
  setInterval(() => void otaCheck(), OTA_EVERY_MS);
  void CapApp.addListener('appStateChange', ({ isActive }) => {
    if (!isActive && !callActive) void otaApply();
    if (isActive) void otaCheck();
  }).catch(() => undefined);
}

/*
  Ход работы инженера на экране блокировки (ТЗ-34, A7). Окно заботы шлёт событие
  `qevo:care-progress`; разрешение на уведомления спрашиваем здесь, если ещё не
  спрашивали: человек сам позвал инженера, повод понятен.
*/
async function careProgress(p: CareProgress | null): Promise<void> {
  if (deviceInfo?.os !== 'android') return;
  try {
    if (!p) { await AnthillNative.careProgress({ clear: true }); return; }
    if (localPerm === 'default') localPerm = toPerm((await LocalNotifications.requestPermissions()).display);
    if (localPerm !== 'granted') return;
    await AnthillNative.careProgress(careNotification(p));
  } catch { /* старая оболочка без метода — полоса только в окне заботы */ }
}

function requestPushToken(): Promise<string | null> {
  if (pushToken) return pushToken;
  pushToken = (async () => {
    try {
      /*
        Без Firebase (нет google-services.json) `register()` не возвращает ошибку, а
        роняет процесс — первый выпуск закрывался сразу после входа. Спрашиваем оболочку
        заранее; появится файл — push включится сам, без правок здесь.
      */
      const { available } = await AnthillNative.pushAvailable().catch(() => ({ available: false }));
      if (!available) return null;
      const perm = await PushNotifications.requestPermissions();
      if (perm.receive !== 'granted') return null;
      const token = new Promise<string | null>((resolve) => {
        void PushNotifications.addListener('registration', (t) => resolve(t.value || null));
        void PushNotifications.addListener('registrationError', () => resolve(null));
        setTimeout(() => resolve(null), 15_000); // FCM не ответил — представимся без токена
      });
      await PushNotifications.createChannel({ id: 'anthill', name: 'QEVO', importance: 4, sound: 'default' }).catch(() => undefined);
      await PushNotifications.register();
      return await token;
    } catch { return null; }
  })();
  return pushToken;
}

/**
 * Шторка Android — только о непрочитанном (#1531).
 *
 * Раньше уведомление висело в шторке, пока его не смахнёшь: задачу уже приняли,
 * сообщение прочитали на компьютере, а напоминание о нём осталось. Теперь после
 * каждой сверки с ящиком убираем всё, чего среди непрочитанного больше нет.
 * Push от Firebase несут путь в `data.path`; если система его не отдала — сверяем
 * по заголовку и тексту, а не угадываем.
 */
function stillUnread(
  keep: { path: string | null; title: string; body: string }[],
  path: string | null, title: string, body: string,
): boolean {
  if (path) return keep.some((k) => k.path === path);
  return keep.some((k) => k.title === title && (!body || k.body === body));
}
async function pruneShade(keep: { path: string | null; title: string; body: string }[] | null): Promise<void> {
  // локальные — те, что приложение показало само по сокету
  try {
    const delivered = (await LocalNotifications.getDeliveredNotifications()).notifications ?? [];
    const gone = delivered.filter((n) => n.id !== CALL_NOTIFICATION_ID
      && (!keep || !stillUnread(keep, localKeys.get(n.id) ?? null, n.title ?? '', n.body ?? '')));
    if (gone.length) {
      await LocalNotifications.removeDeliveredNotifications({ notifications: gone });
      for (const n of gone) { localKeys.delete(n.id); clickHandlers.delete(n.id); }
    }
  } catch { /* старый WebView */ }
  // push — те, что показала система, пока приложение спало
  try {
    const { notifications } = await PushNotifications.getDeliveredNotifications();
    const gone = (notifications ?? []).filter((n) => {
      const data = (n.data ?? {}) as Record<string, unknown>;
      // звонок и сигналы фокуса в ящик не пишутся — сверять их не с чем, не трогаем
      if (Object.keys(data).length && !data.inboxId) return false;
      if (!keep) return true;
      const path = typeof data.path === 'string' && data.path ? data.path : null;
      return !stillUnread(keep, path, n.title ?? '', n.body ?? '');
    });
    if (gone.length) await PushNotifications.removeDeliveredNotifications({ notifications: gone });
  } catch { /* push не подключён */ }
}

void PushNotifications.addListener('pushNotificationActionPerformed', (e) => {
  const path = String(e.notification.data?.path ?? '');
  if (path) for (const h of deepLinkHandlers) h(path);
}).catch(() => undefined);
void PushNotifications.addListener('pushNotificationReceived', () => {
  window.dispatchEvent(new Event('teamcrm:push-foreground'));
}).catch(() => undefined);

/**
 * Значки в строке состояния — под тему приложения, а не системы (волна 12).
 * Приложение тёмное, система светлая — без этого часы на тёмной шапке не видны.
 */
function syncSystemBars(): void {
  const apply = () => {
    const explicit = document.documentElement.getAttribute('data-theme');
    const dark = explicit ? explicit === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    void SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => undefined);
  };
  apply();
  try {
    new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
  } catch { /* старый WebView */ }
}

async function warmUp(): Promise<void> {
  await SecureStorage.setKeyPrefix('anthill.');
  await Promise.all(KEYS.map(async (k) => {
    const v = await SecureStorage.getItem(k).catch(() => null);
    if (v != null) cache.set(k, v);
  }));
  const [d, a] = await Promise.all([Device.getInfo().catch(() => null), CapApp.getInfo().catch(() => null)]);
  await prepareLocalNotifications();
  /*
    Содержимое не попадает в переключатель приложений (ТЗ-9, D-07). Снимки экрана при этом
    разрешены (preventScreenshots: false в capacitor.config): без них человек не может
    показать, что у него сломалось, — это мешало больше, чем защищало.
  */
  void PrivacyScreen.enable().catch(() => undefined);
  syncSystemBars();
  window.addEventListener('qevo:care-progress', (e) => void careProgress((e as CustomEvent<CareProgress | null>).detail ?? null));
  deviceInfo = {
    kind: 'capacitor',
    os: d?.platform === 'ios' ? 'ios' : d?.platform === 'android' ? 'android' : 'other',
    nativeVersion: a ? `${a.version} (${a.build})` : null,
    bundleVersion: BUNDLE_VERSION,
    model: d ? `${d.manufacturer ? `${d.manufacturer} ` : ''}${d.model} · ${d.operatingSystem} ${d.osVersion}` : null,
  };
  startOta();
}
const ready = warmUp();

export const capacitorBridge: PlatformBridge = {
  ...browserBridge,

  info: () => deviceInfo ?? { ...browserBridge.info(), kind: 'capacitor' },
  deviceUuid: () => Device.getId().then((r) => r.identifier || null).catch(() => null),

  notifications: {
    permission: () => localPerm,
    async requestPermission() {
      try { localPerm = toPerm((await LocalNotifications.requestPermissions()).display); } catch { localPerm = 'denied'; }
      return localPerm;
    },
    show(title, body, onClick, key) {
      if (localPerm !== 'granted') return;
      const id = nextLocalId++;
      if (onClick) clickHandlers.set(id, onClick);
      localKeys.set(id, key ?? null);
      void LocalNotifications.schedule({
        notifications: [{ id, title, body, channelId: 'anthill', smallIcon: 'ic_stat_notify' }],
      }).catch(() => undefined);
    },
    prune: pruneShade,
    setBadge: browserBridge.notifications.setBadge,
    pushToken: requestPushToken,
    progress: (p) => void careProgress(p),
  },

  appUpdate: {
    ...browserBridge.appUpdate,
    async canInstall() {
      try { return (await AnthillNative.canInstall()).supported; } catch { return false; }
    },
    install: installUpdate,
    async requestInstallPermission() {
      try { await AnthillNative.requestInstallPermission(); } catch { /* настройки нет — останется ссылка */ }
    },
    async permitted() {
      try { return (await AnthillNative.canInstall()).allowed; } catch { return false; }
    },
    check: otaCheck,
    async apply() { await otaApply(); },
  },

  biometrics: {
    async available() {
      try { return (await BiometricAuth.checkBiometry()).isAvailable; } catch { return false; }
    },
    async authenticate(reason) {
      try {
        // Код устройства как запасной путь: биометрия могла не сработать (перчатки, маска).
        await BiometricAuth.authenticate({ reason, allowDeviceCredential: true, cancelTitle: 'Отмена' });
        return true;
      } catch { return false; }
    },
  },

  secureStorage: {
    ready: () => ready,
    get: (key) => cache.get(key) ?? null,
    set: (key, value) => {
      cache.set(key, value);
      void SecureStorage.setItem(key, value).catch(() => undefined);
    },
    remove: (key) => {
      cache.delete(key);
      void SecureStorage.removeItem(key).catch(() => undefined);
    },
  },

  share: {
    canShare: () => true,
    async share(data) {
      try {
        const can = await Share.canShare();
        if (!can.value) return false;
        await Share.share({ title: data.title, text: data.text, url: data.url, dialogTitle: data.title });
        return true;
      } catch { return false; } // отмена системного листа — не ошибка
    },
  },

  deepLinks: {
    /*
      Ссылка, по которой открыли приложение: Universal Link / App Link или наша
      схема. Отдаём путь без домена — роутер веба и так умеет `/projects/130/task/1315`.
      Первую ссылку (холодный старт) тоже отдаём: слушатель успевает подписаться до
      того, как WebView закончит грузиться, но `getLaunchUrl` надёжнее.
    */
    onOpen(handler) {
      const toPath = (url: string): string | null => {
        try { const u = new URL(url); return `${u.pathname}${u.search}`; } catch { return null; }
      };
      const sub = CapApp.addListener('appUrlOpen', (e) => { const p = toPath(e.url); if (p) handler(p); });
      void CapApp.getLaunchUrl().then((l) => { const p = l?.url ? toPath(l.url) : null; if (p) handler(p); });
      deepLinkHandlers.add(handler); // нажатие на push ведёт туда же
      return () => { void sub.then((h) => h.remove()); deepLinkHandlers.delete(handler); };
    },
  },

  haptics: {
    play(kind) {
      const run = kind === 'light' ? Haptics.impact({ style: ImpactStyle.Light })
        : kind === 'medium' ? Haptics.impact({ style: ImpactStyle.Medium })
          : Haptics.notification({ type: kind === 'success' ? NotificationType.Success : kind === 'warning' ? NotificationType.Warning : NotificationType.Error });
      void run.catch(() => undefined);
    },
  },
  calls: {
    ...browserBridge.calls,
    /*
      Входящий звонок, когда приложение свёрнуто: своё окно вызова человек не увидит,
      а уведомление с высоким приоритетом и звуком — увидит. Нажатие открывает приложение.
      Полноэкранный входящий и CallKit — позже, когда будет Firebase и Apple Developer.
    */
    async reportIncoming(call) {
      if (localPerm !== 'granted') return;
      try {
        await LocalNotifications.schedule({
          notifications: [{
            id: CALL_NOTIFICATION_ID, title: `Входящий звонок · ${call.title}`, body: 'Откройте, чтобы ответить',
            channelId: 'anthill-calls', smallIcon: 'ic_stat_call', ongoing: true, autoCancel: true,
          }],
        });
      } catch { /* не критично */ }
    },
    async reportEnded() {
      try { await LocalNotifications.cancel({ notifications: [{ id: CALL_NOTIFICATION_ID }] }); } catch { /* уже нет */ }
    },
    /*
      Созвон в фоне (волна 7). Android с 14-й версии глушит микрофон свернувшегося
      приложения через минуту — если у него нет foreground service нужного типа.
      Поднимаем его вместе с уведомлением «Идёт созвон» на всё время звонка и не
      даём экрану уснуть; iOS держит звук сам, пока сессия активна (CallKit — позже).
    */
    async keepAwake(on) {
      callActive = on; // посреди созвона бандл не меняем: перезагрузка оборвала бы звонок
      try { if (on) await KeepAwake.keepAwake(); else await KeepAwake.allowSleep(); } catch { /* не критично */ }
      if (deviceInfo?.os !== 'android') return;
      try {
        if (on) {
          await ForegroundService.startForegroundService({
            id: 1, title: 'Идёт созвон', body: 'QEVO держит микрофон включённым',
            smallIcon: 'ic_stat_call', serviceType: ServiceType.Microphone,
          });
        } else {
          await ForegroundService.stopForegroundService();
        }
      } catch { /* без сервиса звонок всё равно идёт, пока приложение на экране */ }
    },
    /*
      Звук созвона к уху, а не в громкую связь (задача #1464). Только Android: там
      Chromium сам включает громкую связь при звонке. Старая сборка без метода —
      отвечаем «не умею», и кнопку громкой связи окно не покажет.
    */
    async setAudioRoute(route) {
      if (deviceInfo?.os !== 'android') return null;
      try { return (await AnthillNative.setAudioRoute({ route })).route; } catch { return null; }
    },
  },

  filesystem: {
    async save(name, blob) {
      // В оболочке нет «скачать»: кладём в документы приложения и отдаём системному листу.
      const buf = await blob.arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const written = await Filesystem.writeFile({ path: name, data: btoa(bin), directory: Directory.Cache });
      await Share.share({ title: name, url: written.uri }).catch(() => undefined);
    },
  },

  openExternal(url) {
    // Системный браузер (Custom Tabs / SFSafariViewController), а не переход внутри WebView.
    void Browser.open({ url });
  },
};