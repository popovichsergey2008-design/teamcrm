import { browserBridge, buildKind } from './browser';
import type { PlatformBridge, PlatformKind } from './types';

export type * from './types';

/*
  Точка входа: `platform.*` — то, чем пользуются компоненты.

  Мост подменяется один раз при старте оболочки (`setPlatformBridge(capacitorBridge)`),
  до первого рендера. Компоненты держат ссылку на объект-обёртку, а не на конкретную
  реализацию, поэтому подмена не требует ничего перерисовывать.
*/
let current: PlatformBridge = browserBridge;

export function setPlatformBridge(bridge: PlatformBridge): void {
  current = bridge;
}

export const platform: PlatformBridge = {
  info: () => current.info(),
  get secureStorage() { return current.secureStorage; },
  get notifications() { return current.notifications; },
  get biometrics() { return current.biometrics; },
  get share() { return current.share; },
  get appUpdate() { return current.appUpdate; },
  get deepLinks() { return current.deepLinks; },
  get calls() { return current.calls; },
  get filesystem() { return current.filesystem; },
  openExternal: (url) => current.openExternal(url),
};

/** Режим сборки: `web` | `mobile-web` | `capacitor`. Внутри оболочки — всегда capacitor. */
export function platformKind(): PlatformKind {
  const w = window as Window & { Capacitor?: { isNativePlatform?: () => boolean } };
  if (w.Capacitor?.isNativePlatform?.()) return 'capacitor';
  return buildKind();
}

/** Внутри нативной оболочки: есть push, биометрия, системные звонки. */
export function isNativeShell(): boolean {
  return platformKind() === 'capacitor';
}