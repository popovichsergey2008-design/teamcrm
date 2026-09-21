import { App as CapApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Device } from '@capacitor/device';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
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

async function warmUp(): Promise<void> {
  await SecureStorage.setKeyPrefix('anthill.');
  await Promise.all(KEYS.map(async (k) => {
    const v = await SecureStorage.getItem(k).catch(() => null);
    if (v != null) cache.set(k, v);
  }));
  const [d, a] = await Promise.all([Device.getInfo().catch(() => null), CapApp.getInfo().catch(() => null)]);
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
      return () => { void sub.then((h) => h.remove()); };
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