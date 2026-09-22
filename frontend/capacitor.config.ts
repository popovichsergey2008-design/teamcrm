import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Оболочка Capacitor для Android и iOS (ТЗ-9, волна 2).
 *
 * Внутри — тот же веб-фронт из `dist-capacitor` (сборка `npm run build:capacitor`):
 * бандл лежит на устройстве, API — на anthill.team (см. src/lib/origin.ts). Нативные
 * проекты живут в `native/android` и `native/ios`, генерируются `npx cap add` и
 * обновляются `npx cap sync` после каждой сборки бандла.
 */
const config: CapacitorConfig = {
  appId: 'team.anthill.app',
  appName: 'ANTHILL',
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
    allowNavigation: ['anthill.team', '*.anthill.team'],
  },
  plugins: {
    SplashScreen: { launchAutoHide: true, launchShowDuration: 600, backgroundColor: '#0b0d12' },
    Keyboard: { resize: 'body' },
    // Переключатель приложений содержимое не показывает, снимки экрана — можно (D-07 с поправкой).
    PrivacyScreen: { enable: true, preventScreenshots: false },
  },
};

export default config;