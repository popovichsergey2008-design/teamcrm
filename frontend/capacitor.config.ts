import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Оболочка Capacitor для Android и iOS (ТЗ-9, волна 2).
 *
 * Внутри — тот же веб-фронт из `dist-capacitor` (сборка `npm run build:capacitor`):
 * бандл лежит на устройстве, API — на qevo.one (см. src/lib/origin.ts). Нативные
 * проекты живут в `native/android` и `native/ios`, генерируются `npx cap add` и
 * обновляются `npx cap sync` после каждой сборки бандла.
 */
const config: CapacitorConfig = {
  appId: 'team.anthill.app',
  appName: 'QEVO',
  webDir: 'dist-capacitor',
  android: { path: 'native/android' },
  ios: { path: 'native/ios' },
  server: {
    /*
      Один origin `https://localhost` на обеих платформах: у бэкенда он в CORS_ORIGIN,
      и Secure-cookie/Notification API работают только на https-схеме.
    */
    androidScheme: 'https',
    iosScheme: 'https',
    /*
      Куда WebView может переходить сам: только наш домен. Всё остальное — во внешний
      браузер (Custom Tabs / Safari), чтобы чужой сайт не открывался внутри приложения
      с нашим мостом в ОС.
    */
    allowNavigation: ['qevo.one', '*.qevo.one', 'anthill.team', '*.anthill.team'],
  },
  plugins: {
    SplashScreen: { launchAutoHide: true, launchShowDuration: 600, backgroundColor: '#f5f1ea' },
    Keyboard: { resize: 'body' },
    // 10.11: выключено — на Android плагин ставит FLAG_SECURE и запрещает снимки экрана,
    // а заказчику нужно присылать скриншоты багов (см. platform/capacitor.ts).
    PrivacyScreen: { enable: false },
  },
};

export default config;