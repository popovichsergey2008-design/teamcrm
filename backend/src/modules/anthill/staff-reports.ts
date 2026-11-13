/**
 * Сводка отчётов сотрудников (#4893, п. 9). Сотрудники уже присылают ежедневные отчёты
 * текстом и ссылками на таблицы — в личку руководителю и в группу «ОТЧЁТЫ»; руководитель
 * читал их по одному. Здесь — чистые правила: что считать отчётом, статус «по плану» /
 * «риски», ссылки на Google-таблицы, кто не прислал.
 */

export interface ReportMessage { authorId: string; author: string; body: string; chatTitle: string | null; at: Date }
export interface PersonReport { authorId: string; author: string; done: string[]; status: 'по плану' | 'риски'; risks: string[]; sheets: string[]; chats: string[] }

const RISK = /(риск|проблем|не успева|не успел|задерж|блок|жду\s|ждём|ждем|не могу|сорв|перенос|сломал|ошибк|не получ|отстаём|отстаем|завис)/i;
const SHEET = /https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})[^\s)]*/g;

/** Похоже на ежедневный отчёт: группа «ОТЧЁТЫ» или текст начинается с «Отчёт…». */
export function isReport(m: { body: string; chatTitle: string | null }): boolean {
  return /отч[её]т/i.test(m.chatTitle ?? '') || /^\s*(#?\s*)?отч[её]т/i.test(m.body) || /отч[её]т за (вчера|сегодня|день|\d)/i.test(m.body);
}

export function sheetLinks(body: string): string[] {
  return [...body.matchAll(SHEET)].map((m) => m[0]);
}

/** CSV-выгрузка таблицы с открытым доступом — без входа, только чтение. */
export function sheetCsvUrl(link: string): string | null {
  const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(link)?.[1];
  if (!id) return null;
  const gid = /[#&?]gid=(\d+)/.exec(link)?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}

/** Строки отчёта → «что сделано» и риски; по человеку — один блок за день. */
export function summarize(list: ReportMessage[]): PersonReport[] {
  const by = new Map<string, PersonReport>();
  for (const m of list) {
    const p = by.get(m.authorId) ?? { authorId: m.authorId, author: m.author, done: [], status: 'по плану' as const, risks: [], sheets: [], chats: [] };
    const lines = m.body.split(/\n+/).map((l) => l.replace(/^\s*([-•*–]|\d+[.)])\s*/, '').trim())
      .filter((l) => l && !/^#?\s*отч[её]т/i.test(l) && !/^https?:\/\//.test(l));
    for (const l of lines) {
      if (RISK.test(l)) p.risks.push(l.slice(0, 200));
      else p.done.push(l.slice(0, 200));
    }
    p.sheets.push(...sheetLinks(m.body));
    if (m.chatTitle && !p.chats.includes(m.chatTitle)) p.chats.push(m.chatTitle);
    if (p.risks.length) p.status = 'риски';
    by.set(m.authorId, p);
  }
  return [...by.values()].sort((a, b) => (a.status === b.status ? a.author.localeCompare(b.author, 'ru') : a.status === 'риски' ? -1 : 1));
}

export function reportsText(people: PersonReport[], missing: string[], dayLabel: string, sheetNotes: Map<string, string>): string {
  if (!people.length && !missing.length) return `Отчётов за ${dayLabel} не нашёл: ни в группах с «отчёт» в названии, ни в личке.`;
  const lines: string[] = [`Отчёты сотрудников за ${dayLabel}: прислали ${people.length}${missing.length ? `, не прислали ${missing.length}` : ''}.`];
  for (const p of people) {
    lines.push(`\n${p.author} — ${p.status}`);
    if (p.done.length) lines.push(`Сделано: ${p.done.slice(0, 5).join('; ')}`);
    if (p.risks.length) lines.push(`Риски: ${p.risks.slice(0, 3).join('; ')}`);
    for (const s of p.sheets.slice(0, 2)) lines.push(`Таблица: ${sheetNotes.get(s) ?? 'доступа нет — откройте доступ по ссылке, чтобы я её читал'}`);
  }
  if (missing.length) lines.push(`\nНе прислали: ${missing.join(', ')}.`);
  return lines.join('\n');
}

/** Короткий пересказ CSV: заголовки и сколько строк. */
export function csvNote(csv: string): string {
  const rows = csv.split(/\r?\n/).filter((r) => r.trim());
  if (!rows.length) return 'таблица пустая';
  const head = rows[0].split(',').map((c) => c.replace(/^"|"$/g, '').trim()).filter(Boolean).slice(0, 6);
  const last = rows.length > 1 ? rows[rows.length - 1].split(',').map((c) => c.replace(/^"|"$/g, '').trim()).filter(Boolean).slice(0, 6) : [];
  return `${rows.length - 1} строк; колонки: ${head.join(', ')}${last.length ? `; последняя строка: ${last.join(' · ')}` : ''}`;
}
