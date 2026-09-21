/**
 * Откуда брать API (ТЗ-9, волна 2).
 *
 * В браузере фронт и API живут на одном origin, и все адреса относительные: `/api/…`,
 * `/socket.io`, `/ws/meet`. Внутри оболочки Capacitor веб-бандл лежит на устройстве
 * (origin `https://localhost`), а сервер — на `anthill.team`: относительный адрес
 * ушёл бы в никуда. Поэтому origin API задаётся сборкой (`VITE_API_ORIGIN` в
 * `.env.capacitor`), а всё, что ходит на сервер, собирает адрес здесь, в одном месте.
 * Пустой origin = как раньше, относительно страницы.
 */
const env: { VITE_API_ORIGIN?: string } = (import.meta as { env?: { VITE_API_ORIGIN?: string } }).env ?? {};

export const API_ORIGIN = String(env.VITE_API_ORIGIN ?? '').replace(/\/+$/, '');

/** Абсолютный (в оболочке) или относительный (в браузере) адрес по пути вида `/api/…`. */
export function apiUrl(path: string): string {
  return `${API_ORIGIN}${path}`;
}

/** Адрес WebSocket по пути вида `/ws/meet`: wss на HTTPS-origin, ws — на HTTP. */
export function wsUrl(path: string): string {
  if (API_ORIGIN) return `${API_ORIGIN.replace(/^http/, 'ws')}${path}`;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}${path}`;
}