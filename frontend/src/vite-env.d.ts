/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Режим сборки фронта: web | mobile-web | capacitor (см. src/platform). */
  readonly VITE_PLATFORM?: string;
  /** Версия веб-бандла, подставляется сборкой (vite.config.ts). */
  readonly VITE_BUNDLE_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}