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
import { registerPlugin, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { browserBridge, BUNDLE_VERSION } from './browser';
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
const CALL_NOTIFICATION_ID = 900_001;

function toPerm(v: string | undefined): Perm {
  return v === 'granted' ? 'granted' : v === 'denied' ? 'denied' : 'default';
}
async function prepareLocalNotifications(): Promise<void> {
  try {
    localPerm = toPerm((await LocalNotifications.checkPermissions()).display);
    await LocalNotifications.createChannel({ id: 'anthill', name: 'ANTHILL', importance: 4, sound: 'default', description: 'Сообщения, задачи, напоминания' });
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
const AnthillNative = registerPlugin<{ pushAvailable(): Promise<{ available: boolean }> }>('AnthillNative');

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
      await PushNotifications.createChannel({ id: 'anthill', name: 'ANTHILL', importance: 4, sound: 'default' }).catch(() => undefined);
      await PushNotifications.register();
      return await token;
    } catch { return null; }
  })();
  return pushToken;
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
  deviceInfo = {
    kind: 'capacitor',
    os: d?.platform === 'ios' ? 'ios' : d?.platform === 'android' ? 'android' : 'other',
    nativeVersion: a ? `${a.version} (${a.build})` : null,
    bundleVersion: BUNDLE_VERSION,
    model: d ? `${d.manufacturer ? `${d.manufacturer} ` : ''}${d.model} · ${d.operatingSystem} ${d.osVersion}` : null,
  };
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
    show(title, body, onClick) {
      if (localPerm !== 'granted') return;
      const id = nextLocalId++;
      if (onClick) clickHandlers.set(id, onClick);
      void LocalNotifications.schedule({
        notifications: [{ id, title, body, channelId: 'anthill', smallIcon: 'ic_stat_notify' }],
      }).catch(() => undefined);
    },
    setBadge: browserBridge.notifications.setBadge,
    pushToken: requestPushToken,
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
      try { if (on) await KeepAwake.keepAwake(); else await KeepAwake.allowSleep(); } catch { /* не критично */ }
      if (deviceInfo?.os !== 'android') return;
      try {
        if (on) {
          await ForegroundService.startForegroundService({
            id: 1, title: 'Идёт созвон', body: 'ANTHILL держит микрофон включённым',
            smallIcon: 'ic_stat_call', serviceType: ServiceType.Microphone,
          });
        } else {
          await ForegroundService.stopForegroundService();
        }
      } catch { /* без сервиса звонок всё равно идёт, пока приложение на экране */ }
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