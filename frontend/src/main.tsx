import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './app.css';
import { App } from './App';
import { AuthProvider } from './state/auth';
import { initTheme } from './lib/theme';
import { initRouter } from './lib/router';
import { unlockAudio } from './lib/sound';

initTheme(); // до первой отрисовки: иначе тёмная тема мигнёт светлым
initRouter(); // адрес должен быть разобран до первого рендера, иначе экран мигнёт разделом по умолчанию
unlockAudio(); // браузер не даст звучать до первого касания страницы — готовимся заранее

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
