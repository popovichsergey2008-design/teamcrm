/**
 * Итоги клиенту сразу после звонка (#1525, фича 5) — чистые правила без базы и модели:
 * тема «Итоги встречи DD.MM», короткая строка договорённостей для окна, текст для
 * Telegram от имени компании и одноразовый код ссылки t.me/<бот>?start=<код>.
 */
import { createHash, randomBytes } from 'crypto';

/** Код ссылки живёт две недели: клиент не всегда открывает её в тот же день. */
export const CLIENT_CODE_TTL_DAYS = 14;
const CODE_PREFIX = 'c_';

/** «Итоги встречи 06.10» — день встречи по поясу организатора. */
export function followupSubject(at: Date, tz: string): string {
  let dd = String(at.getUTCDate()).padStart(2, '0');
  let mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  try {
    const parts = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit' }).formatToParts(at);
    dd = parts.find((p) => p.type === 'day')?.value ?? dd;
    mm = parts.find((p) => p.type === 'month')?.value ?? mm;
  } catch { /* неизвестный пояс — UTC */ }
  return `Итоги встречи ${dd}.${mm}`;
}

const LEAD = /^(?:мы\s+)?(?:договорились|решили|решено|согласовали|итог)\s*(?::|—|-|,)?\s*что\s+|^(?:мы\s+)?(?:договорились|решили|решено|итог)\s*(?::|—|-)\s*/i;

/** Одна договорённость коротко: без «Решили:», без точки в конце, не длиннее ~80 знаков. */
function shortItem(raw: string, names: Set<string>): string {
  let s = raw.replace(/\s+/g, ' ').trim().replace(LEAD, '').trim();
  // первое предложение — суть; пояснения после точки в окно не нужны
  const dot = s.search(/[.!?;](\s|$)/);
  if (dot > 0) s = s.slice(0, dot);
  s = s.replace(/[\s.,;:!?—-]+$/u, '').trim();
  if (s.length > 80) {
    const cut = s.slice(0, 80);
    const sp = cut.lastIndexOf(' ');
    s = `${(sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/u, '')}…`;
  }
  // со строчной, как в середине фразы — кроме имён («Глеб пришлёт смету») и сокращений («API»)
  const first = s.split(/[\s,]/)[0] ?? '';
  const abbr = (first.match(/\p{Lu}/gu) ?? []).length > 1;
  if (first && !abbr && !names.has(first.toLowerCase())) s = s.charAt(0).toLowerCase() + s.slice(1);
  return s;
}

/**
 * «утвердили дизайн, правки до среды.» — из решений встречи, как их записал итог.
 * Решений нет — из поручений со сроками. Ничего не выдумываем: нечего сказать — null.
 */
export function agreementsLine(
  decisions: string[],
  tasks: { title: string; deadline: string | null }[],
  names: Iterable<string> = [],
  max = 3,
): string | null {
  const keep = new Set([...names].map((n) => n.trim().toLowerCase()).filter(Boolean));
  const src = decisions.map(String).map((d) => d.trim()).filter(Boolean);
  const raw = src.length ? src : tasks.filter((t) => t.title?.trim()).map((t) => `${t.title.trim()}${t.deadline ? ` до ${t.deadline}` : ''}`);
  const items: string[] = [];
  for (const r of raw) {
    const s = shortItem(r, keep);
    if (s && !items.some((x) => x.toLowerCase() === s.toLowerCase())) items.push(s);
    if (items.length >= max) break;
  }
  if (!items.length) return null;
  // в пунктах есть запятые — разделяем точкой с запятой, иначе пункты слипнутся
  const sep = items.some((x) => x.includes(',')) ? '; ' : ', ';
  const line = items.join(sep);
  return /[…]$/.test(line) ? line : `${line}.`;
}

/** Текст окна дословно по документу. */
export function popupText(subject: string, agreements: string | null): string[] {
  return [
    'Я подготовил отчет для вашего клиента.',
    `Тема: ${subject}`,
    ...(agreements ? [`Договоренности: ${agreements}`] : []),
    'Отправить клиенту в Telegram в 1 клик?',
  ];
}

/**
 * Сообщение клиенту в Telegram от бота QEVO. Клиент должен сразу видеть, ОТ КОГО оно:
 * компания и человек, а не безымянный бот. Лимит Telegram — 4096 знаков.
 */
export function telegramMessage(f: { subject: string; company: string; sender: string; body: string }): string {
  const head = `${f.subject}\nОт: ${f.sender}, ${f.company}`;
  const foot = `Сообщение отправил бот QEVO от имени компании «${f.company}» (отправитель — ${f.sender}).`;
  const room = 4000 - head.length - foot.length - 8;
  const body = f.body.trim().length > room ? `${f.body.trim().slice(0, room - 1)}…` : f.body.trim();
  return `${head}\n\n${body}\n\n${foot}`;
}

/** После первой доставки по ссылке: клиент знает, что бот теперь его, и как его отключить. */
export function subscribedText(company: string): string {
  return `Готово: итоги следующих встреч с «${company}» тоже будут приходить сюда. Отключить — команда /stop.`;
}

export const EXPIRED_TEXT = 'Ссылка устарела или уже использована. Попросите менеджера прислать итоги ещё раз.';

/** Ответ на любое другое сообщение клиента: бот не чат с менеджером. */
export function clientChatText(company: string): string {
  return `Это бот QEVO: сюда приходят итоги встреч от «${company}». Ответить менеджеру лучше в привычном канале. Отключить — команда /stop.`;
}

/** Текст ссылки для клиента — во внешний чат или письмом. */
export function linkInvite(subject: string, url: string): string {
  return [
    `${subject} — в Telegram: ${url}`,
    'Нажмите «Запустить» — бот QEVO сразу пришлёт итоги, а следующие будут приходить туда же.',
  ].join('\n');
}

/** Новый код: 128 бит случайности; в базе — только хеш. */
export function newClientCode(): { code: string; hash: string } {
  const code = CODE_PREFIX + randomBytes(16).toString('base64url');
  return { code, hash: hashClientCode(code) };
}

export function hashClientCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** «/start c_…» → код клиента; другие /start (код сотрудника из веб-CRM) — не наши. */
export function clientCodeOf(text: string): string | null {
  const m = /^\/start(?:@\w+)?\s+(c_[A-Za-z0-9_-]{16,60})\s*$/.exec(text.trim());
  return m ? m[1] : null;
}

export function codeExpiry(now = new Date()): Date {
  return new Date(now.getTime() + CLIENT_CODE_TTL_DAYS * 86400_000);
}

/** Ссылка на запуск бота с кодом и обратно — код из ссылки (для повторной отправки той же). */
export function startLink(bot: string, code: string): string {
  return `https://t.me/${bot}?start=${code}`;
}
