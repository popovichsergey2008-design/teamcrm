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

initTheme(); // до первой отрисовки: иначе тёмная тема мигнёт светлым
initFontScale(); // тоже до отрисовки: увеличенный шрифт не должен моргать обычным
initRouter(); // адрес должен быть разобран до первого рендера, иначе экран мигнёт разделом по умолчанию
unlockAudio(); // браузер не даст звучать до первого касания страницы — готовимся заранее

/*
  Мост в ОС подменяется ДО первого рендера (ТЗ-9).

  В оболочке Capacitor токены лежат в Keychain/Keystore, и поднять их в память надо
  раньше, чем AuthProvider спросит «есть ли сессия» — иначе человек на каждом
  запуске видел бы экран входа. Код оболочки грузится динамически и только в этом
  режиме: в веб-бандл Capacitor не попадает.
*/
async function boot(): Promise<void> {
  if (platformKind() === 'capacitor') {
    const { capacitorBridge } = await import('./platform/capacitor');
    setPlatformBridge(capacitorBridge);
    await platform.secureStorage.ready();
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </React.StrictMode>,
  );
}

void boot();