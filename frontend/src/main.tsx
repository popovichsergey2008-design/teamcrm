import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './app.css';
import { App } from './App';
import { AuthProvider } from './state/auth';
import { initTheme } from './lib/theme';

initTheme(); // до первой отрисовки: иначе тёмная тема мигнёт светлым

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
