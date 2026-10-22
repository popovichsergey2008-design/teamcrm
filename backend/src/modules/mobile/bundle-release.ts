/**
 * Веб-бандл для обновления по воздуху (ТЗ-34, этап D) — чистые правила без Nest и диска.
 *
 * CI после каждой выкладки main собирает веб-часть оболочки (`dist-capacitor`), кладёт
 * zip и `bundle/latest.json` рядом с APK. Оболочка Android спрашивает `/mobile/bundle`,
 * качает zip, сверяет sha256 (и подпись, если в оболочке зашит ключ) и применяет его со
 * следующего запуска. Здесь — что считать годным манифестом и кому его отдавать.
 */

export interface BundleRelease {
  /** Та же строка, что `BUNDLE_VERSION` внутри бандла: `2026.10.22-abc1234`. */
  version: string;
  /** Самая старая оболочка, с которой бандл работает: ему нужны её нативные методы. */
  minNative: string;
  url: string;
  sha256: string;
  /** Обязательное: ставить, даже если встроенный в APK бандл новее (откат плохой выкладки). */
  mandatory: boolean;
  /** ECDSA P-256 над строкой `version\nsha256`, base64 (DER). Нет ключа в CI — нет подписи. */
  signature?: string;
  sizeBytes?: number;
  publishedAt?: string;
}

/** Откуда оболочке можно качать бандл: только наш домен и только https. */
const ALLOWED_URL = /^https:\/\/(?:[a-z0-9-]+\.)?(?:qevo\.one|anthill\.team)\/[^\s]*$/i;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.\-_]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/i;

/** Сравнение версий вида 1.49 / 1.49 (149): только числа по порядку. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const parse = (v: string | null | undefined) => String(v ?? '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Разобрать манифест (файл CI или ручная настройка техотдела). Всё, что не проходит
 * проверку, — «бандла нет»: оболочка останется на том, что у неё есть, а не скачает
 * архив с чужого адреса или без контрольной суммы.
 */
export function parseBundleRelease(raw: unknown): BundleRelease | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const version = typeof r.version === 'string' ? r.version.trim() : '';
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  const sha256 = typeof r.sha256 === 'string' ? r.sha256.trim().toLowerCase() : '';
  const minNative = typeof r.minNative === 'string' && r.minNative.trim() ? r.minNative.trim() : '0';
  if (!VERSION.test(version) || !ALLOWED_URL.test(url) || !SHA256.test(sha256)) return null;
  const signature = typeof r.signature === 'string' && /^[A-Za-z0-9+/=]{16,400}$/.test(r.signature) ? r.signature : undefined;
  return {
    version, minNative, url, sha256, mandatory: r.mandatory === true,
    ...(signature ? { signature } : {}),
    ...(typeof r.sizeBytes === 'number' && r.sizeBytes > 0 ? { sizeBytes: r.sizeBytes } : {}),
    ...(typeof r.publishedAt === 'string' ? { publishedAt: r.publishedAt } : {}),
  };
}

/**
 * Отдавать ли бандл этой оболочке. Оболочка старше `minNative` — нет: бандл позовёт
 * нативный метод, которого в ней нет. Версию оболочка не назвала — тоже нет: без неё
 * совместимость не проверить, а сломанный интерфейс хуже старого.
 */
export function bundleForNative(release: BundleRelease | null, native: string | null | undefined): BundleRelease | null {
  if (!release) return null;
  const n = String(native ?? '').trim();
  if (!/\d/.test(n)) return null;
  return compareVersions(n, release.minNative) >= 0 ? release : null;
}
