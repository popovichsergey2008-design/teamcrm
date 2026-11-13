/**
 * Ссылки на объекты Qevo в тексте сообщения (#4902, п. 3 «живые карточки»).
 *
 * Тот же разбор, что на сервере (`backend/src/modules/link-cards/link-parse.ts`):
 * клиент решает, ПОД какими ссылками рисовать карточки, а что за объект и видит ли его
 * человек — решает сервер, адрес он разбирает заново. Модуль едет только в ленивом
 * куске карточек — в первый экран не попадает.
 *
 * Наши хосты — qevo.one, старые anthill.team и teamsmrt.com, плюс адрес, с которого
 * открыто приложение (dev-сервер, стенд). Чужой сайт с похожим путём — не наш.
 */

export type QevoLinkKind = 'task' | 'meeting' | 'file' | 'sheet';
export interface QevoLink { url: string; kind: QevoLinkKind; key: string }

const OUR_HOST = /(^|\.)(qevo\.one|anthill\.team|teamsmrt\.com)$/i;
/** Карточек под одним сообщением — не больше трёх: дальше лента превращается в доску. */
export const MAX_CARDS = 3;

function pathRef(path: string): { kind: QevoLinkKind; id: string } | null {
  const p = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
  let m = /^\/projects\/\d{1,18}\/task\/(\d{1,18})(?:\/check)?$/.exec(p);
  if (m) return { kind: 'task', id: m[1] };
  m = /^\/meetings\/(\d{1,18})(?:\/postcall)?$/.exec(p);
  if (m) return { kind: 'meeting', id: m[1] };
  m = /^\/api\/files\/(\d{1,18})$/.exec(p);
  if (m) return { kind: 'file', id: m[1] };
  return null;
}

/** Одна ссылка → что за объект. `ownHost` — хост открытого приложения (для стенда и dev). */
export function parseQevoLink(raw: string, ownHost = ''): { kind: QevoLinkKind; id: string } | null {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 2048) return null;
  if (s.startsWith('/') && !s.startsWith('//')) return pathRef(s);
  let url: URL;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (host === 'docs.google.com') {
    const m = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,128})(?:\/|$)/.exec(url.pathname);
    return m ? { kind: 'sheet', id: m[1] } : null;
  }
  if (!OUR_HOST.test(host) && !(ownHost && host === ownHost.toLowerCase())) return null;
  return pathRef(url.pathname);
}

/**
 * Ссылки из текста сообщения — до трёх разных объектов, в порядке появления.
 *
 * Картинки `![снимок](/api/files/12)` пропускаем: они и так показаны картинкой, карточка
 * файла под ней была бы повтором. Точку или скобку в конце предложения от адреса отрезаем.
 */
export function extractQevoLinks(text: string, ownHost = ''): QevoLink[] {
  const src = String(text ?? '').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  // без lookbehind: старый Safari на iPhone не разбирает его, и ленивый кусок не загрузился бы
  const re = /(https?:\/\/[^\s<>()[\]"'`]+)|(?:^|[\s(])(\/(?:projects|meetings|api\/files)\/[^\s<>()[\]"'`]+)/g;
  const out: QevoLink[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(re)) {
    const url = (m[1] ?? m[2] ?? '').replace(/[.,;:!?»…]+$/, '');
    const ref = parseQevoLink(url, ownHost);
    if (!ref) continue;
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, kind: ref.kind, key });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}
