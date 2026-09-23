/**
 * PlatformBridge — единственная дверь из общего фронта в операционную систему (ТЗ-9).
 *
 * Один и тот же React-фронт живёт в трёх местах: в браузере на компьютере, в браузере
 * телефона (PWA) и внутри нативной оболочки Capacitor на Android/iOS. Компоненты не
 * должны знать, где именно они запущены: они просят «покажи уведомление», «сохрани
 * токен надёжно», «поделись ссылкой» — а как это делается (Notification API или
 * системный центр уведомлений, localStorage или Keychain/Keystore, navigator.share или
 * системный лист) решает реализация моста. Иначе через месяц в каждом компоненте будет
 * `if (isCapacitor) … else …`, и мобильная версия начнёт расходиться с вебом.
 *
 * Правило: интерфейсы описывают ТОЛЬКО то, что действительно отличается между
 * платформами. Всё остальное — обычный код фронта.
 */

/** Где запущен фронт. `mobile-web` — тот же браузер, но сборка под телефон (PWA). */
export type PlatformKind = 'web' | 'mobile-web' | 'capacitor';

export type PlatformOs = 'ios' | 'android' | 'desktop' | 'other';

export interface PlatformInfo {
  kind: PlatformKind;
  os: PlatformOs;
  /** Версия нативной оболочки — есть только внутри Capacitor. */
  nativeVersion: string | null;
  /** Версия веб-бандла: по ней сервер решает, совместим ли клиент. */
  bundleVersion: string;
  /** Модель устройства — для диагностики в службе заботы; в браузере — короткое имя. */
  model: string | null;
}

/**
 * Надёжное хранилище секретов (токены сессии).
 *
 * Чтение синхронное намеренно: клиент API читает токен на каждом запросе, и делать
 * каждый запрос асинхронным ради Keychain — переписывать весь `api.ts`. Нативная
 * реализация поднимает значения в память при старте (`ready()`), дальше отдаёт из неё,
 * а запись уходит в Keychain/Keystore в фоне.
 */
export interface SecureStorageBridge {
  /** Дождаться, пока значения подняты из хранилища ОС. В браузере — сразу. */
  ready(): Promise<void>;
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface NotificationsBridge {
  permission(): NotificationPermissionState;
  /** Только по явному действию человека: непрошеный запрос браузеры и ОС глушат. */
  requestPermission(): Promise<NotificationPermissionState>;
  /** Показать уведомление, когда приложение не на виду. Молча ничего не делает без разрешения. */
  show(title: string, body: string, onClick?: () => void): void;
  /** Число на значке приложения / в заголовке вкладки. */
  setBadge(count: number): void;
  /**
   * Токен push (FCM/APNs) — только в оболочке; в браузере null. Сервер привязывает его
   * к устройству, чтобы будить приложение, когда оно закрыто.
   */
  pushToken(): Promise<string | null>;
}

export interface BiometricsBridge {
  available(): Promise<boolean>;
  /** true — человек подтвердил себя; false — отказался или не смог. */
  authenticate(reason: string): Promise<boolean>;
}

export interface ShareBridge {
  canShare(): boolean;
  /** true — поделились; false — отменили или платформа не умеет. */
  share(data: { title?: string; text?: string; url?: string }): Promise<boolean>;
}

/**
 * Чем кончилась попытка поставить обновление.
 *
 * `installing` — файл скачан и проверен, дальше спрашивает система; `needs_permission` —
 * человек ещё не разрешил установку из нашего приложения; `unsupported` — платформа так
 * не умеет (браузер, iOS), остаётся обычная ссылка.
 */
export type InstallUpdateResult = 'installing' | 'needs_permission' | 'unsupported' | 'failed';

export interface AppUpdateBridge {
  /** Есть ли новая версия (оболочки или веб-бандла); в браузере всегда null. */
  check(): Promise<{ version: string; mandatory: boolean } | null>;
  /** Умеет ли оболочка обновить себя сама. Нет — показываем ссылку на скачивание. */
  canInstall(): Promise<boolean>;
  /**
   * Скачать выпуск и отдать системному установщику. `onProgress` — доля от 0 до 1;
   * файл сверяется с контрольной суммой до установки.
   */
  install(
    release: { url: string; sha256: string; version: string },
    onProgress?: (share: number) => void,
  ): Promise<InstallUpdateResult>;
  /** Открыть системную настройку «разрешать установку из этого источника». */
  requestInstallPermission(): Promise<void>;
  /** Скачать и применить: оболочка перезапустит веб-бандл сама. */
  apply(): Promise<void>;
}

export interface DeepLinksBridge {
  /**
   * Ссылка, по которой приложение открыли (или разбудили), — чистый путь без домена:
   * `/projects/130/task/1315`. В браузере таких событий нет — маршрут берётся из адреса.
   */
  onOpen(handler: (path: string) => void): () => void;
}

export interface CallIntegrationBridge {
  /** Показать входящий звонок средствами ОС (CallKit / уведомление о звонке). */
  reportIncoming(call: { id: string; title: string; video: boolean }): Promise<void>;
  reportEnded(callId: string): Promise<void>;
  /** Во время активного звонка ОС не должна усыпить приложение. */
  keepAwake(on: boolean): Promise<void>;
}

export interface FilesystemBridge {
  /** Сохранить файл «в загрузки»: в браузере — обычное скачивание. */
  save(name: string, blob: Blob): Promise<void>;
}

export interface PlatformBridge {
  info(): PlatformInfo;
  /** Стабильный id установки от ОС — им телефон представляется серверу; в браузере null. */
  deviceUuid(): Promise<string | null>;
  secureStorage: SecureStorageBridge;
  notifications: NotificationsBridge;
  biometrics: BiometricsBridge;
  share: ShareBridge;
  appUpdate: AppUpdateBridge;
  deepLinks: DeepLinksBridge;
  calls: CallIntegrationBridge;
  filesystem: FilesystemBridge;
  /** Открыть внешнюю ссылку: в оболочке — системным браузером, а не внутри WebView. */
  openExternal(url: string): void;
}