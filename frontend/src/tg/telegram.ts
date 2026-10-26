import { applyTheme } from '../lib/theme';
import { apiUrl } from '../lib/origin';

/**
 * Telegram Mini App (#4619, этап 5): обёртка над `window.Telegram.WebApp`.
 *
 * Скрипт Telegram грузится ТОЛЬКО на страницах /tg/… и динамически: обычной CRM он
 * не нужен, а внешний скрипт в стартовой сборке — лишний запрос и лишняя зависимость
 * от чужого сервера. Все вызовы — через «мягкие» обёртки: старый клиент Telegram
 * не знает части методов (кнопка «Назад» — с 6.1), и падать из-за этого нельзя.
 */

export interface TgButton {
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  setText?(text: string): void;
  setParams?(p: Record<string, unknown>): void;
}

export interface TgWebApp {
  initData: string;
  initDataUnsafe?: { start_param?: string; user?: { first_name?: string } };
  version?: string;
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string | undefined>;
  ready(): void;
  expand(): void;
  close(): void;
  openLink?(url: string): void;
  isVersionAtLeast?(v: string): boolean;
  setHeaderColor?(c: string): void;
  setBackgroundColor?(c: string): void;
  onEvent?(e: string, cb: () => void): void;
  BackButton?: TgButton;
  MainButton?: TgButton;
  HapticFeedback?: { impactOccurred?(s: string): void; notificationOccurred?(s: string): void; selectionChanged?(): void };
}

declare global {
  interface Window { Telegram?: { WebApp?: TgWebApp } }
}

export const TG_SCRIPT = 'https://telegram.org/js/telegram-web-app.js';

/** Подключить скрипт Telegram. Не загрузился за 6 с — работаем как обычная страница. */
export function loadTelegram(): Promise<TgWebApp | null> {
  if (window.Telegram?.WebApp) return Promise.resolve(window.Telegram.WebApp);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = TG_SCRIPT;
    s.async = true;
    const done = () => { window.clearTimeout(t); resolve(window.Telegram?.WebApp ?? null); };
    const t = window.setTimeout(done, 6000);
    s.onload = done;
    s.onerror = done;
    document.head.appendChild(s);
  });
}

const atLeast = (wa: TgWebApp, v: string) => {
  try { return wa.isVersionAtLeast ? wa.isVersionAtLeast(v) : false; } catch { return false; }
};

/** Тёмный ли фон у Telegram: colorScheme, а если его нет — по яркости bg_color. */
export function isDark(wa: TgWebApp | null): boolean {
  if (wa?.colorScheme) return wa.colorScheme === 'dark';
  const m = /^#?([0-9a-f]{6})$/i.exec(wa?.themeParams?.bg_color ?? '');
  if (!m) return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum < 128;
}

/**
 * Тема: светлая или тёмная — как у Telegram, а цвета — НАШИ токены.
 *
 * Цвета Telegram напрямую не берём: у них своя палитра, и наш текст на их фоне
 * проверке контраста не обязан. Зато шапку и фон окна Telegram красим в наш цвет —
 * тогда шторка выглядит одним целым, а не QEVO в чужой рамке.
 */
export function applyTelegramTheme(wa: TgWebApp | null): void {
  applyTheme(isDark(wa) ? 'dark' : 'light');
  if (!wa || !atLeast(wa, '6.1')) return;
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--bg').trim();
  const head = css.getPropertyValue('--bg-elev').trim();
  try { if (/^#[0-9a-f]{6}$/i.test(head)) wa.setHeaderColor?.(head); } catch { /* старый клиент */ }
  try { if (/^#[0-9a-f]{6}$/i.test(bg)) wa.setBackgroundColor?.(bg); } catch { /* старый клиент */ }
}

/** Кнопка «Назад» в шапке Telegram. Возвращает функцию снятия. */
export function backButton(wa: TgWebApp | null, onBack: (() => void) | null): () => void {
  const b = wa && atLeast(wa, '6.1') ? wa.BackButton : undefined;
  if (!b) return () => undefined;
  if (!onBack) { b.hide(); return () => undefined; }
  b.onClick(onBack);
  b.show();
  return () => { b.offClick(onBack); b.hide(); };
}

/** Главная кнопка внизу окна Telegram. Возвращает функцию снятия. */
export function mainButton(wa: TgWebApp | null, text: string | null, onClick: () => void): () => void {
  const b = wa?.MainButton;
  if (!b || !text) { b?.hide(); return () => undefined; }
  try {
    if (b.setParams) b.setParams({ text, is_visible: true });
    else { b.setText?.(text); b.show(); }
  } catch { return () => undefined; }
  b.onClick(onClick);
  return () => { b.offClick(onClick); b.hide(); };
}

export function haptic(wa: TgWebApp | null, kind: 'tap' | 'success' | 'error'): void {
  const h = wa?.HapticFeedback;
  try {
    if (kind === 'tap') h?.selectionChanged?.();
    else h?.notificationOccurred?.(kind);
  } catch { /* нет вибрации — не беда */ }
}

/** Открыть ссылку наружу: в Telegram — его браузером, иначе новой вкладкой. */
export function openOutside(wa: TgWebApp | null, url: string): void {
  if (wa?.openLink) { try { wa.openLink(url); return; } catch { /* ниже — обычный путь */ } }
  window.open(url, '_blank', 'noopener');
}

/** Закрыть шторку. Вне Telegram закрывать нечего — уводим в бота (имя бота знает сервер). */
export function closeApp(wa: TgWebApp | null): void {
  if (wa?.initData) { try { wa.close(); return; } catch { /* ниже */ } }
  void fetch(apiUrl('/api/auth/providers'))
    .then((r) => r.json())
    .then((env: { data?: { telegramBot?: string | null } }) => env.data?.telegramBot)
    .catch(() => null)
    .then((bot) => { window.location.href = bot ? `https://t.me/${bot}` : '/'; });
}
