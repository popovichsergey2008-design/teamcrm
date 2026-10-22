import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';

/*
  Версия веб-бандла: дата + короткий хеш коммита.

  По ней оболочка Capacitor и сервер решают, совместим ли бандл с нативной частью и
  надо ли его обновлять (ТЗ-9). Берётся из git; вне репозитория — только дата.

  Время — коммита, а не сборки, с минутами (ТЗ-34, этап D): APK и бандл по воздуху,
  собранные из одного коммита в разных прогонах CI, получают одну и ту же версию, а
  версии разных коммитов одного дня сравниваются по порядку (`2026.10.22.1430-abc1234`).
*/
function bundleVersion(): string {
  const stamp = (d: Date) => d.toISOString().slice(0, 16).replace(/-/g, '.').replace('T', '.').replace(':', '');
  try {
    const git = (args: string) => execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const sha = (process.env.GITHUB_SHA ?? git('rev-parse HEAD')).trim();
    const at = Number(git(`show -s --format=%ct ${sha}`)) * 1000;
    return `${stamp(Number.isFinite(at) && at > 0 ? new Date(at) : new Date())}-${sha.slice(0, 7)}`;
  } catch { return stamp(new Date()); }
}

// Dev: проксируем API и WebSocket на локальный backend (Этап 0 docker / nest start).
// Prod: SPA и API за общим edge nginx (один origin) — прокси не нужен.
//
// API_TARGET=https://anthill.team — прогон локального фронта поверх боевого API
// (мобильная раскладка в Playwright с эмуляцией телефона): бэкенд со всеми хранилищами
// локально не поднять, а верстку проверять надо до выкладки.
const apiTarget = process.env.API_TARGET ?? 'http://localhost:3000';
const BUNDLE_VERSION = bundleVersion();
export default defineConfig({
  plugins: [
    react(),
    /*
      Сборка для оболочки кладёт рядом свою версию: CI по ней называет zip и пишет
      bundle/latest.json для обновления по воздуху (ТЗ-34, этап D) — та же строка, что
      `BUNDLE_VERSION` внутри бандла, иначе оболочка качала бы его снова и снова.
    */
    {
      name: 'qevo-bundle-version',
      apply: (_cfg, env) => env.mode === 'capacitor' && env.command === 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'bundle-version.txt', source: BUNDLE_VERSION });
      },
    },
  ],
  define: { 'import.meta.env.VITE_BUNDLE_VERSION': JSON.stringify(BUNDLE_VERSION) },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true, secure: true },
      '/socket.io': { target: apiTarget, ws: true, changeOrigin: true, secure: true },
      '/ws': { target: apiTarget, ws: true, changeOrigin: true, secure: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
