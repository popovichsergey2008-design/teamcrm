import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

/*
  Версия веб-бандла: дата + короткий хеш коммита.

  По ней оболочка Capacitor и сервер решают, совместим ли бандл с нативной частью и
  надо ли его обновлять (ТЗ-9). Берётся из git; вне репозитория — только дата.
*/
function bundleVersion(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  try {
    const sha = (process.env.GITHUB_SHA ?? execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()).trim().slice(0, 7);
    return `${day}-${sha}`;
  } catch { return day; }
}

// Dev: проксируем API и WebSocket на локальный backend (Этап 0 docker / nest start).
// Prod: SPA и API за общим edge nginx (один origin) — прокси не нужен.
export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_BUNDLE_VERSION': JSON.stringify(bundleVersion()) },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
