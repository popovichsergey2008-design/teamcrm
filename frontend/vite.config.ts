import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: проксируем API и WebSocket на локальный backend (Этап 0 docker / nest start).
// Prod: SPA и API за общим edge nginx (один origin) — прокси не нужен.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
