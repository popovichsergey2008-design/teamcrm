/**
 * Ссылка в сообщении → объект Qevo (#4902, п. 3 «Ссылки на задачи — живые карточки»).
 *
 * Чистая функция без базы: что за объект и какой у него номер. Права и содержимое
 * решает сервис — здесь только разбор, поэтому его легко проверить тестами.
 *
 * Хосты — все, под которыми жил продукт: qevo.one (и app., dev.), старые anthill.team
 * и teamsmrt.com. Ссылки, скопированные полгода назад, тоже должны разворачиваться.
 * Относительный путь (`/projects/130/task/4863`) — ссылка внутри своего же приложения.
 * Чужие сайты с похожим путём (`evil.com/projects/1/task/2`) — НЕ наши: по ним карточку
 * не строим, иначе в чате появилась бы «наша» карточка под чужим адресом.
 */

export type LinkRef =
  | { kind: 'task'; id: string; projectId: string }
  | { kind: 'meeting'; id: string }
  | { kind: 'file'; id: string }
  | { kind: 'sheet'; id: string };

const OUR_HOST = /(^|\.)(qevo\.one|anthill\.team|teamsmrt\.com)$/i;
const NUM = '(\\d{1,18})';

/** Путь внутри приложения → объект. Хвосты (`/check`, `?t=735`, `#…`) не мешают. */
function fromPath(path: string): LinkRef | null {
  const p = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
  let m = new RegExp(`^/projects/${NUM}/task/${NUM}(?:/check)?$`).exec(p);
  if (m) return { kind: 'task', id: m[2], projectId: m[1] };
  m = new RegExp(`^/meetings/${NUM}(?:/postcall)?$`).exec(p);
  if (m) return { kind: 'meeting', id: m[1] };
  m = new RegExp(`^/api/files/${NUM}$`).exec(p);
  if (m) return { kind: 'file', id: m[1] };
  return null;
}

/**
 * Разобрать одну ссылку. null — не наша или не объект (раздел, проект целиком, сайт).
 * Google-таблица — по номеру документа: `/spreadsheets/d/<id>/edit#gid=0` и любые хвосты.
 */
export function parseQevoLink(raw: string): LinkRef | null {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 2048) return null;
  if (s.startsWith('/') && !s.startsWith('//')) return fromPath(s);
  let url: URL;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (host === 'docs.google.com') {
    const m = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,128})(?:\/|$)/.exec(url.pathname);
    return m ? { kind: 'sheet', id: m[1] } : null;
  }
  if (!OUR_HOST.test(host)) return null;
  return fromPath(url.pathname);
}

/** Ключ объекта: две ссылки на одну задачу (с хостом и без) — одна карточка. */
export function linkKey(ref: LinkRef): string {
  return `${ref.kind}:${ref.id}`;
}

/**
 * Название Google-таблицы из `<title>` её страницы: «Бюджет — Google Таблицы» → «Бюджет».
 * Пустое или служебное («Google Sheets», страница входа) — null: тогда карточка честно
 * пишет «Google-таблица», а не «Вход в аккаунт».
 */
export function sheetTitle(html: string): string | null {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''))?.[1] ?? '';
  const t = raw
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–—]\s*Google\s+(Sheets|Таблицы|Tabellen|Hojas de cálculo|Feuilles)\s*$/i, '')
    .trim();
  // «Входящие заявки» — законное название таблицы, поэтому ловим именно страницы входа
  if (!t || /^Google\s+(Sheets|Таблицы)(:.*)?$/i.test(t) || /Google\s+(Аккаунты|Accounts)$/i.test(t)) return null;
  return t.slice(0, 200);
}
