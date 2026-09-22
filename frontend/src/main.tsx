import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './app.css';
import { App } from './App';
import { AuthProvider } from './state/auth';
import { initTheme } from './lib/theme';
import { initFontScale } from './lib/font-scale';
import { initRouter } from './lib/router';
import { unlockAudio } from './lib/sound';
import { platform, platformKind, setPlatformBridge } from './platform';
import { installSupportErrorCapture } from './lib/support-context';

initTheme(); // до первой отрисовки: иначе тёмная тема мигнёт светлым
initFontScale(); // тоже до отрисовки: увеличенный шрифт не должен моргать обычным
initRouter(); // адрес должен быть разобран до первого рендера, иначе экран мигнёт разделом по умолчанию
unlockAudio(); // браузер не даст звучать до первого касания страницы — готовимся заранее
installSupportErrorCapture(); // сбои окна — в контекст обращения в службу заботы

/*
  Мост в ОС подменяется ДО первого рендера (ТЗ-9).

  В оболочке Capacitor токены лежат в Keychain/Keystore, и поднять их в память надо
  раньше, чем AuthProvider спросит «есть ли сессия» — иначе человек на каждом
  запуске видел бы экран входа. Код оболочки грузится динамически и только в этом
  режиме: в веб-бандл Capacitor не попадает.
*/
/**
 * Сбой JS в оболочке — на сервер, в ту же ленту, что и нативные падения (волна 12).
 * Белый экран на телефоне человеку не объяснить, а нам без стека не починить.
 * Только в Capacitor: в браузере есть консоль и служба заботы с контекстом.
 */
function reportShellCrash(where: string, e: unknown): void {
  if (platformKind() !== 'capacitor') return;
  const err = e as { message?: string; stack?: string } | undefined;
  const stack = `${where}: ${err?.stack ?? err?.message ?? String(e)}`.slice(0, 15_000);
  try {
    void fetch('https://anthill.team/api/mobile/crash', {
      method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appVersion: `js ${platform.info().bundleVersion}`, device: platform.info().model ?? undefined, os: navigator.userAgent.slice(0, 40), stack, at: new Date().toISOString() }),
    });
  } catch { /* нет сети — молчим */ }
}

async function boot(): Promise<void> {
  if (platformKind() === 'capacitor') {
    const { capacitorBridge } = await import('./platform/capacitor');
    setPlatformBridge(capacitorBridge);
    await platform.secureStorage.ready();
    window.addEventListener('error', (ev) => reportShellCrash('window.error', ev.error ?? ev.message));
    window.addEventListener('unhandledrejection', (ev) => reportShellCrash('unhandledrejection', (ev as PromiseRejectionEvent).reason));
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </React.StrictMode>,
  );
}

boot().catch((e) => { reportShellCrash('boot', e); throw e; });
