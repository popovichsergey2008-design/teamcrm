/**
 * Инфоцентр проекта и ИИ-библиотекарь (#4659) — чистые правила, без базы.
 *
 * Здесь решается, куда положить ссылку или файл, что считать мусором, как узнать
 * повтор и как проверить ответ модели. Правила работают и без ключа ИИ: ссылка на
 * Figma — это макет, на GitHub — репозиторий, «Брендбук.pdf» — брендбук, и для этого
 * модель не нужна. Модель добавляет только неочевидное и проходит строгую проверку.
 */

export type HubSection = 'passport' | 'team' | 'knowledge';
export type HubKind = 'link' | 'file' | 'contact' | 'note';

export const SECTIONS: HubSection[] = ['passport', 'team', 'knowledge'];
export const KINDS: HubKind[] = ['link', 'file', 'contact', 'note'];

/** Допустимые категории по разделам — одна проверка для людей и для модели. */
export const CATEGORIES: Record<HubSection, string[]> = {
  passport: ['site', 'app', 'admin', 'social', 'bot', 'other'],
  knowledge: ['spec', 'brand', 'design', 'repo', 'api', 'regulation', 'doc', 'other'],
  team: ['contractor', 'client', 'other'],
};

export function validCategory(section: string, category: string | null | undefined): boolean {
  if (category == null || category === '') return true;
  return (CATEGORIES[section as HubSection] ?? []).includes(category);
}

/** Куда легла находка. */
export interface Placement { section: HubSection; category: string; title: string }

// ── ссылки ─────────────────────────────────────────────────────────────────────

/** Ссылки из текста — то же правило, что у ленты ссылок чата (`extractLinks`). */
export function extractUrls(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of String(text ?? '').matchAll(/(?:https?:\/\/|www\.)[^\s<>"'()\]]+/gi)) {
    const url = m[0].replace(/[).,;:!?»"'\]]+$/, '');
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** Метки рекламы и переходов — не часть адреса: без них один макет — одна ссылка. */
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|yclid|_openstat|ref_src|si)$/i;

/**
 * Ссылка в одном виде для сравнения: https, хост маленькими буквами без «www.», без
 * меток рекламы, якоря и косой черты в конце. null — не ссылка.
 */
export function normalizeUrl(raw: string): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^www\./i.test(s)) s = `https://${s}`;
  if (!/^https?:\/\//i.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (!u.hostname || !u.hostname.includes('.')) return null;
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  let out = u.toString();
  if (out.endsWith('/') && !u.search) out = out.slice(0, -1);
  return out;
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/** Хост совпадает с доменом или его поддоменом: `app.figma.com` → `figma.com`. */
const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Свои адреса системы и одноразовые ссылки созвонов: в базе знаний они бесполезны. */
const OWN = ['qevo.one', 'anthill.team', 'teamsmrt.com', 'localhost'];
const MEETING_LINKS = ['meet.google.com', 'zoom.us', 'telemost.yandex.ru', 'teams.microsoft.com', 'meet.jit.si', 'whereby.com'];
/** Сокращатели: что за ними — не видно, раскладывать нечего. */
const SHORTENERS = ['bit.ly', 'clck.ru', 'tinyurl.com', 'goo.gl', 'cutt.ly'];

export interface UrlContext {
  /** Свои домены проекта: сайт из паспорта — ссылки на них идут в «Паспорт». */
  projectDomains?: string[];
  /** Адрес системы из настроек (APP_BASE_URL) — тоже свой. */
  appHost?: string | null;
}

/** Мусор ли ссылка: своя система, созвон, сокращатель, прямая картинка, адрес по IP. */
export function isJunkUrl(url: string, ctx: UrlContext = {}): boolean {
  const host = hostOf(url);
  if (!host) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  const own = [...OWN, ...(ctx.appHost ? [ctx.appHost.toLowerCase().replace(/^www\./, '')] : [])];
  if (own.some((d) => onDomain(host, d))) return true;
  if (MEETING_LINKS.some((d) => onDomain(host, d))) return true;
  if (SHORTENERS.includes(host)) return true;
  let path = '';
  try { path = new URL(url).pathname.toLowerCase(); } catch { return true; }
  // прямая ссылка на картинку — тот же скриншот, только по адресу
  if (/\.(png|jpe?g|gif|webp|heic|bmp)$/.test(path)) return true;
  return false;
}

/** Последний осмысленный кусок пути: «Landing-v2» → «Landing v2». */
function pathTitle(url: string, skip = 0): string | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean).slice(skip);
    const last = parts[parts.length - 1];
    if (!last) return null;
    const t = decodeURIComponent(last).replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    return t && !/^[A-Za-z0-9]{16,}$/.test(t) ? t.slice(0, 80) : null;
  } catch { return null; }
}

/** Владелец/репозиторий из пути GitHub/GitLab: «org/app». */
function repoTitle(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] ?? null;
  } catch { return null; }
}

/**
 * Куда положить ссылку по домену. null — правила не знают (решит модель, если есть)
 * или это мусор. Порядок важен: сначала мусор, потом свои домены проекта, потом
 * известные сервисы.
 */
export function classifyUrl(url: string, ctx: UrlContext = {}): Placement | null {
  const n = normalizeUrl(url);
  if (!n || isJunkUrl(n, ctx)) return null;
  const host = hostOf(n);
  let path = '';
  try { path = new URL(n).pathname.toLowerCase(); } catch { /* уже проверено */ }

  // свой сайт проекта: админка и приложение — по поддомену или пути
  const own = (ctx.projectDomains ?? []).map((d) => d.toLowerCase().replace(/^www\./, '')).filter(Boolean);
  const ownBase = own.find((d) => onDomain(host, d) || onDomain(d, host));
  if (ownBase) {
    if (/^admin\.|^cms\./.test(host) || /^\/(admin|wp-admin|dashboard|cms)(\/|$)/.test(path)) {
      return { section: 'passport', category: 'admin', title: `Админка ${host}` };
    }
    if (/^(app|my|lk|cabinet)\./.test(host)) return { section: 'passport', category: 'app', title: `Приложение ${host}` };
    return null; // сам сайт уже в паспорте, его страницы — не знания
  }

  if (onDomain(host, 'figma.com')) {
    const name = pathTitle(n, 2);
    return { section: 'knowledge', category: 'design', title: name ? `Макет Figma: ${name}` : 'Макет Figma' };
  }
  if (['miro.com', 'sketch.com', 'zeplin.io', 'invisionapp.com', 'pixso.net', 'pixso.cn'].some((d) => onDomain(host, d))) {
    return { section: 'knowledge', category: 'design', title: `Дизайн: ${host}` };
  }
  if (['github.com', 'gitlab.com', 'bitbucket.org', 'gitflic.ru'].some((d) => onDomain(host, d)) || /^git(lab)?\./.test(host)) {
    const r = repoTitle(n);
    return { section: 'knowledge', category: 'repo', title: r ? `Репозиторий ${r}` : `Репозиторий ${host}` };
  }
  if (/swagger|redoc|api-docs|openapi/.test(host + path) || /^\/(docs\/api|api\/docs)(\/|$)/.test(path)
    || onDomain(host, 'postman.com') || onDomain(host, 'stoplight.io')) {
    return { section: 'knowledge', category: 'api', title: `Документация API: ${host}` };
  }
  if (onDomain(host, 'docs.google.com') || onDomain(host, 'drive.google.com')) {
    const what = path.startsWith('/spreadsheets') ? 'Таблица Google' : path.startsWith('/presentation') ? 'Презентация Google'
      : path.startsWith('/document') ? 'Документ Google' : 'Файл Google Диска';
    return { section: 'knowledge', category: 'doc', title: what };
  }
  if (onDomain(host, 'notion.so') || onDomain(host, 'notion.site')) {
    const name = pathTitle(n)?.replace(/\s+[0-9a-f]{20,}$/i, '');
    return { section: 'knowledge', category: 'doc', title: name ? `Notion: ${name}` : 'Страница Notion' };
  }
  if (/confluence|wiki\./.test(host) || onDomain(host, 'atlassian.net') || onDomain(host, 'disk.yandex.ru')
    || onDomain(host, 'docs.yandex.ru') || onDomain(host, 'yadi.sk') || onDomain(host, 'dropbox.com')) {
    return { section: 'knowledge', category: 'doc', title: `Документ: ${host}` };
  }
  if (onDomain(host, 't.me') || onDomain(host, 'telegram.me')) {
    let name = '';
    try { name = new URL(n).pathname.split('/').filter(Boolean)[0] ?? ''; } catch { /* уже проверено */ }
    if (/bot$/i.test(name)) return { section: 'passport', category: 'bot', title: `Бот @${name}` };
    // приглашения в группы (+abc, joinchat) — разовые, в паспорт не годятся
    if (!name || name.startsWith('+') || name === 'joinchat' || name === 'c') return null;
    return { section: 'passport', category: 'social', title: `Telegram @${name}` };
  }
  const social: [string, string][] = [
    ['vk.com', 'ВКонтакте'], ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'], ['instagram.com', 'Instagram'],
    ['dzen.ru', 'Дзен'], ['rutube.ru', 'Rutube'], ['tiktok.com', 'TikTok'], ['ok.ru', 'Одноклассники'],
    ['x.com', 'X'], ['twitter.com', 'X'], ['facebook.com', 'Facebook'], ['linkedin.com', 'LinkedIn'],
  ];
  const s = social.find(([d]) => onDomain(host, d));
  if (s) {
    // ролик на YouTube — не канал проекта, а разовая ссылка
    if ((s[0] === 'youtube.com' && path.startsWith('/watch')) || s[0] === 'youtu.be') return null;
    return { section: 'passport', category: 'social', title: s[1] };
  }
  return null;
}

// ── файлы ──────────────────────────────────────────────────────────────────────

const IMAGE = /^image\//i;
/** Снимки экрана и фото с телефона без смысла в имени. */
const SCREENSHOT_NAME = /^(screenshot|screen ?shot|скриншот|снимок( экрана)?|image|img|photo|фото|clipboard|изображение|pasted|telegram|whatsapp|unnamed)[\s_\-().\d]*\.[a-z0-9]+$/i;

/**
 * Куда положить файл: по имени и типу, подпись сообщения — в помощь. null — мусор
 * (скриншоты, фото без подписи) или правило не знает (решит модель, если есть).
 */
export function classifyFile(name: string, contentType: string | null, caption = ''): Placement | null {
  const file = String(name ?? '').trim();
  if (!file) return null;
  const hay = `${file} ${caption}`.toLowerCase();
  const ext = (file.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]) ?? '';
  const title = file.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 200) || file.slice(0, 200);

  // \b не видит кириллицу — границы слова пишем явно
  // stem — начало слова («брендбука»); whole — слово целиком: «лого» не должно ловить
  // «логов», а «тз» — «тзадачи». Подчёркивание и цифры в именах файлов — тоже граница.
  const B = '[^\\p{L}]';
  const stem = (re: string) => new RegExp(`(^|${B})(${re})`, 'iu').test(hay);
  const whole = (re: string) => new RegExp(`(^|${B})(${re})($|${B})`, 'iu').test(hay);
  if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) return { section: 'knowledge', category: 'brand', title: `Шрифт: ${title}` };
  if (stem('брендбук|brand ?book|brandbook|гайдлайн|guideline|логотип|logotype|шрифт|палитр|айдентик|фирменн')
    || whole('лого|logo|logos|font|fonts')) {
    return { section: 'knowledge', category: 'brand', title };
  }
  if (stem('техзадани|техническое задание|бриф|специфик|требовани|requirements|specification')
    || whole('тз|brief|spec|specs|prd')) {
    return { section: 'knowledge', category: 'spec', title };
  }
  if (stem('регламент|инструкци|положени|руководств|памятк') || whole('policy|manual|how ?to|guide')) {
    return { section: 'knowledge', category: 'regulation', title };
  }
  if (['fig', 'sketch', 'psd', 'ai', 'xd'].includes(ext)) return { section: 'knowledge', category: 'design', title: `Макет: ${title}` };
  if (ext === 'svg') return { section: 'knowledge', category: 'brand', title };
  // картинки и фото без смысла в имени и подписи — скриншоты переписки
  if (IMAGE.test(contentType ?? '') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(ext)) return null;
  return null;
}

/** Явный скриншот — не кандидат даже для модели: незачем платить за его разбор. */
export function isJunkFile(name: string, contentType: string | null, caption = ''): boolean {
  const file = String(name ?? '').trim();
  if (!file) return true;
  const isImage = IMAGE.test(contentType ?? '') || /\.(png|jpe?g|gif|webp|heic|bmp)$/i.test(file);
  if (!isImage) return false;
  if (classifyFile(file, contentType, caption)) return false; // «логотип.png» — не мусор
  // картинка без подписи — скриншот; с подписью — пусть смотрит модель
  return SCREENSHOT_NAME.test(file) || !caption.trim();
}

// ── кандидаты и повторы ────────────────────────────────────────────────────────

export interface Origin {
  type: 'chat_message' | 'meeting' | 'task' | 'comment';
  id: string;
  chatId?: string;
  taskId?: string;
  meetingId?: string;
}

/** Находка за сутки: ссылка или файл с местом, откуда взяли. */
export interface Candidate {
  ref: string;
  kind: 'link' | 'file';
  url?: string;
  fileId?: string;
  fileName?: string;
  contentType?: string | null;
  /** подпись: текст сообщения или комментария вокруг находки */
  context: string;
  origin: Origin;
}

/** Сырые находки: ссылки и файлы источника до проверки на мусор и повторы. */
export interface RawFind {
  text: string;
  files?: { id: string; name: string; contentType: string | null }[];
  origin: Origin;
}

/**
 * Кандидаты из сырых находок: мусор отсечён, повторы схлопнуты (ссылка — по
 * нормальному виду, файл — по номеру), уже лежащее в Инфоцентре (в том числе
 * убранное человеком) — пропущено. Порядок — как в источниках: первое упоминание.
 */
export function buildCandidates(
  finds: RawFind[], known: { urls: Set<string>; fileIds: Set<string> }, ctx: UrlContext = {},
): Candidate[] {
  const out: Candidate[] = [];
  const seenUrl = new Set<string>();
  const seenFile = new Set<string>();
  for (const f of finds) {
    const context = String(f.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    for (const raw of extractUrls(f.text)) {
      const url = normalizeUrl(raw);
      if (!url || isJunkUrl(url, ctx) || seenUrl.has(url) || known.urls.has(url)) continue;
      seenUrl.add(url);
      out.push({ ref: `c${out.length + 1}`, kind: 'link', url, context, origin: f.origin });
    }
    for (const file of f.files ?? []) {
      const id = String(file.id);
      if (seenFile.has(id) || known.fileIds.has(id)) continue;
      if (isJunkFile(file.name, file.contentType, f.text ?? '')) continue;
      seenFile.add(id);
      out.push({
        ref: `c${out.length + 1}`, kind: 'file', fileId: id, fileName: file.name, contentType: file.contentType,
        context, origin: f.origin,
      });
    }
  }
  return out;
}

/** Раскладка правилами: что правила узнали — сразу место; остальное — для модели. */
export function placeByRules(cands: Candidate[], ctx: UrlContext = {}): { placed: Map<string, Placement>; rest: Candidate[] } {
  const placed = new Map<string, Placement>();
  const rest: Candidate[] = [];
  for (const c of cands) {
    const p = c.kind === 'link' ? classifyUrl(c.url!, ctx) : classifyFile(c.fileName ?? '', c.contentType ?? null, c.context);
    if (p) placed.set(c.ref, p); else rest.push(c);
  }
  return { placed, rest };
}

/** Итог прогона для бейджа. */
export interface Added { links: number; files: number; contacts: number; notes: number; decisions: number }

export function addedTotal(a: Partial<Added> | null | undefined): number {
  if (!a) return 0;
  return (a.links ?? 0) + (a.files ?? 0) + (a.contacts ?? 0) + (a.notes ?? 0) + (a.decisions ?? 0);
}

/** «+2 решения, +1 ссылка» — подпись бейджа, если понадобится серверу (Telegram и т. п.). */
export function addedLabel(a: Partial<Added>): string {
  const plural = (n: number, one: string, few: string, many: string) => {
    const m10 = n % 10; const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };
  const parts: string[] = [];
  const add = (n: number | undefined, one: string, few: string, many: string) => {
    if (n) parts.push(`+${n} ${plural(n, one, few, many)}`);
  };
  add(a.decisions, 'решение', 'решения', 'решений');
  add(a.links, 'ссылка', 'ссылки', 'ссылок');
  add(a.files, 'файл', 'файла', 'файлов');
  add(a.contacts, 'контакт', 'контакта', 'контактов');
  add(a.notes, 'заметка', 'заметки', 'заметок');
  return parts.join(', ');
}

// ── проверка ответа модели ─────────────────────────────────────────────────────

export interface ModelItem { ref: string; section: HubSection; category: string; title: string }
export interface ModelContact { name: string; role: string | null; phone: string | null; email: string | null; telegram: string | null; ref: string }
export interface ModelNote { text: string; ref: string }
export interface ModelAnswer { items: ModelItem[]; contacts: ModelContact[]; notes: ModelNote[] }

/** Достаём JSON из ответа модели: она любит обернуть его в ```json и пояснения. */
export function parseJsonLoose(raw: string): unknown {
  const s = String(raw ?? '').trim();
  try { return JSON.parse(s); } catch { /* дальше */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const digits = (s: string) => s.replace(/\D+/g, '');

/** Телефон есть в тексте буквально: по цифрам, не короче 7 — «+7 (999) 123-45-67» = «79991234567». */
export function phoneInText(phone: string, text: string): boolean {
  const d = digits(phone);
  if (d.length < 7) return false;
  return digits(text).includes(d) || digits(text).includes(d.replace(/^8/, '7')) || digits(text).includes(d.replace(/^7/, '8'));
}

export function emailInText(email: string, text: string): boolean {
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && text.toLowerCase().includes(e);
}

export function telegramInText(tg: string, text: string): boolean {
  const h = tg.trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').toLowerCase();
  if (!/^[a-z0-9_]{4,32}$/.test(h)) return false;
  const t = text.toLowerCase();
  return t.includes(`@${h}`) || t.includes(`t.me/${h}`);
}

/**
 * Строгая проверка ответа модели. Принимаем только то, что опирается на настоящее:
 * - запись — ref на кандидата, которого правила НЕ разложили, раздел и категория из списка;
 * - контакт и заметка — ref на присланный источник; имя контакта есть в тексте источника;
 *   телефон, почта, telegram — только если буквально есть в тексте источника, иначе поле
 *   выбрасываем (модель не должна «дописать» номер).
 * Всё остальное молча отбрасывается — разбор не падает из-за одной ошибки модели.
 */
export function validateModelAnswer(
  parsed: unknown,
  cands: { refs: Set<string> },
  sources: Map<string, string>,
): ModelAnswer {
  const out: ModelAnswer = { items: [], contacts: [], notes: [] };
  if (!parsed || typeof parsed !== 'object') return out;
  const o = parsed as Record<string, unknown>;
  const seen = new Set<string>();
  for (const x of Array.isArray(o.items) ? o.items.slice(0, 50) : []) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const ref = str(r.ref, 20);
    const section = str(r.section, 12) as HubSection;
    const category = str(r.category, 16);
    const title = str(r.title, 200);
    if (!cands.refs.has(ref) || seen.has(ref)) continue;
    if (section !== 'passport' && section !== 'knowledge') continue; // команда — только контактами
    if (!category || !validCategory(section, category) || !title) continue;
    seen.add(ref);
    out.items.push({ ref, section, category, title });
  }
  const names = new Set<string>();
  for (const x of Array.isArray(o.contacts) ? o.contacts.slice(0, 20) : []) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const ref = str(r.ref, 20);
    const text = sources.get(ref);
    const name = str(r.name, 100);
    if (!text || !name) continue;
    // имя — тоже из текста: хотя бы одно слово имени длиннее двух букв встречается в источнике
    const words = name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (!words.length || !words.some((w) => text.toLowerCase().includes(w))) continue;
    const key = name.toLowerCase();
    if (names.has(key)) continue;
    names.add(key);
    const phone = str(r.phone, 40);
    const email = str(r.email, 120);
    const telegram = str(r.telegram, 60);
    out.contacts.push({
      name, role: str(r.role, 100) || null, ref,
      phone: phone && phoneInText(phone, text) ? phone : null,
      email: email && emailInText(email, text) ? email.toLowerCase() : null,
      telegram: telegram && telegramInText(telegram, text) ? `@${telegram.replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '')}` : null,
    });
  }
  for (const x of Array.isArray(o.notes) ? o.notes.slice(0, 10) : []) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const ref = str(r.ref, 20);
    const text = str(r.text, 500);
    if (!sources.has(ref) || text.length < 10) continue;
    out.notes.push({ text, ref });
  }
  return out;
}
