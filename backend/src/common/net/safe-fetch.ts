import { lookup as dnsLookup } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';

/**
 * Безопасное чтение внешней страницы по ссылке пользователя (ТЗ-33, §48–49).
 *
 * Ссылку присылает человек (или модель по его просьбе), а запрос уходит с нашего
 * сервера — значит, по неосторожной ссылке можно достучаться до того, что снаружи
 * закрыто: localhost, внутренняя сеть Docker, служебный адрес облака с ключами.
 * Поэтому:
 *   - только http/https и обычные порты, без логина в адресе;
 *   - адрес проверяется ПОСЛЕ разрешения имени, в момент соединения (свой `lookup`),
 *     — иначе имя, которое сначала указывает наружу, а потом на 127.0.0.1, проскочит;
 *   - каждое перенаправление проверяется заново, их не больше трёх;
 *   - ограничены время, размер и типы содержимого.
 */

export class UnsafeUrlError extends Error {}

const PORTS = new Set(['', '80', '443', '8080', '8443']);
const BAD_HOSTS = /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i;

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}
const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

/** Внутренний, служебный или зарезервированный адрес — туда не ходим. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (kind === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateIp(mapped[1]);
    if (s === '::' || s === '::1') return true;
    if (/^f[cd]/.test(s)) return true; // fc00::/7 — частные
    if (/^fe[89ab]/.test(s)) return true; // fe80::/10 — локальные
    if (/^ff/.test(s)) return true; // групповые
    if (s.startsWith('64:ff9b:') || s.startsWith('2001:db8:')) return true;
    return false;
  }
  return true; // не адрес вовсе — не пускаем
}

/** Проверка самой ссылки до любого запроса. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UnsafeUrlError('Это не ссылка'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeUrlError('Открываются только ссылки http и https');
  if (u.username || u.password) throw new UnsafeUrlError('Ссылки с логином и паролем не открываем');
  if (!PORTS.has(u.port)) throw new UnsafeUrlError('Нестандартный порт — такую ссылку не открываем');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !isIP(host)) throw new UnsafeUrlError('Внутренние адреса не открываем');
  if (BAD_HOSTS.test(host)) throw new UnsafeUrlError('Внутренние адреса не открываем');
  if (isIP(host) && isPrivateIp(host)) throw new UnsafeUrlError('Внутренние адреса не открываем');
  return u;
}

/** `lookup` для http(s).request: соединяемся только с проверенным внешним адресом. */
const guardedLookup: typeof dnsLookup = ((host: string, opts: any, cb: any) => {
  dnsLookup(host, { ...(typeof opts === 'object' ? opts : {}), all: true }, (err, addrs: any) => {
    if (err) return cb(err);
    const list = (addrs as { address: string; family: number }[]) ?? [];
    if (!list.length || list.some((a) => isPrivateIp(a.address))) {
      return cb(new UnsafeUrlError('Адрес ведёт во внутреннюю сеть — не открываем'));
    }
    if (opts && typeof opts === 'object' && opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}) as typeof dnsLookup;

const TEXT_TYPES = /^(text\/(html|plain|xml|markdown)|application\/(xhtml\+xml|xml|json|rss\+xml|atom\+xml))/i;

export interface FetchedPage { url: string; status: number; contentType: string; body: string; bytes: number; truncated: boolean }

export async function safeFetch(raw: string, opts: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; types?: RegExp } = {}): Promise<FetchedPage> {
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  let url = checkUrl(raw);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop += 1) {
    const r = await once(url, maxBytes, timeoutMs, opts.types ?? TEXT_TYPES);
    if (r.redirect) {
      url = checkUrl(new URL(r.redirect, url).toString());
      continue;
    }
    return { ...r.page!, url: url.toString() };
  }
  throw new UnsafeUrlError('Слишком много перенаправлений');
}

function once(url: URL, maxBytes: number, timeoutMs: number, types: RegExp): Promise<{ redirect?: string; page?: FetchedPage }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      lookup: guardedLookup,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'QEVO-Bot/1.0 (+https://qevo.one)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
        'Accept-Language': 'ru,en;q=0.8',
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: String(res.headers.location) });
      }
      const contentType = String(res.headers['content-type'] ?? '');
      if (!types.test(contentType)) {
        res.destroy();
        return reject(new UnsafeUrlError(`Это не страница, а ${contentType.split(';')[0] || 'файл'} — такое не читаем`));
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      res.on('data', (c: Buffer) => {
        if (truncated) return;
        bytes += c.length;
        if (bytes > maxBytes) { truncated = true; chunks.push(c.subarray(0, Math.max(0, c.length - (bytes - maxBytes)))); res.destroy(); return; }
        chunks.push(c);
      });
      const finish = () => resolve({ page: { url: url.toString(), status, contentType, body: decode(Buffer.concat(chunks), contentType), bytes: Math.min(bytes, maxBytes), truncated } });
      res.on('end', finish);
      res.on('close', () => { if (truncated) finish(); });
      res.on('error', (e) => (truncated ? finish() : reject(e)));
    });
    req.on('timeout', () => req.destroy(new UnsafeUrlError('Сайт не ответил вовремя')));
    req.on('error', reject);
    req.end();
  });
}

function decode(buf: Buffer, contentType: string): string {
  const cs = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

/** Страница → читаемый текст: без скриптов, стилей и разметки. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const text = html
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|header|footer|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: title.slice(0, 200), text };
}
