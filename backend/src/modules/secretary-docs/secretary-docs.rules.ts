/**
 * #1476 — четыре функции секретаря из таблицы Бориса. Чистые правила: без базы, часов и модели.
 *
 *   F20 сроки документов — когда напоминать (за 30/7/1 день и в день окончания, один раз на порог);
 *   F11 поздравления     — когда у клиента дата (накануне или в сам день) и черновик без модели;
 *   F21 проверка договора — рискованные формулировки по словам (работает и без ключа ИИ,
 *                           а с моделью — как страховка: модель иногда пропускает очевидное);
 *   F24 чеки             — разбор ответа модели в поля авансового отчёта.
 */

// ───────────────────────────── даты ─────────────────────────────

const DAY = 86_400_000;
/** 'YYYY-MM-DD' → номер дня (UTC), чтобы разница не зависела от пояса сервера. */
export function dayNo(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
}
export const daysBetween = (fromIso: string, toIso: string) => dayNo(toIso) - dayNo(fromIso);

export const DOC_KINDS = ['passport', 'visa', 'insurance', 'contract', 'license', 'other'] as const;
export type DocKind = typeof DOC_KINDS[number];
export const DOC_KIND_LABEL: Record<DocKind, string> = {
  passport: 'Паспорт', visa: 'Виза', insurance: 'Страховой полис', contract: 'Договор', license: 'Лицензия / разрешение', other: 'Документ',
};

export const plural = (n: number, a: string, b: string, c: string) => {
  const m10 = Math.abs(n) % 10; const m100 = Math.abs(n) % 100;
  return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c;
};

/**
 * Пора ли напомнить о сроке документа. Возвращает порог (дни; 0 — сегодня, -1 — истёк) или null.
 *
 * Порог срабатывает один раз: напомнили за 30 дней — на 29-й не повторяем. Документ
 * добавили, когда до конца уже 5 дней, — сразу напоминаем ближайшим подходящим порогом
 * (7), а пропущенный 30 не догоняем: два сообщения подряд про одно и то же не нужны.
 */
export function docReminder(row: { expires_on: string; remind_days: number[]; reminded: number[]; renewed_at: unknown }, today: string): number | null {
  if (row.renewed_at) return null;
  const left = daysBetween(today, row.expires_on);
  const done = new Set(row.reminded ?? []);
  if (left < 0) return done.has(-1) ? null : -1;
  if (left === 0) return done.has(0) ? null : 0;
  const hit = [...new Set(row.remind_days ?? [])].filter((d) => d > 0 && left <= d).sort((a, b) => a - b)[0];
  if (hit === undefined || done.has(hit)) return null;
  // уже напоминали меньшим порогом (ближе к сроку) — больший не нужен
  if ([...done].some((d) => d >= 0 && d < hit)) return null;
  return hit;
}

/** Какие пороги отметить напомненными: сработавший и все бо́льшие — их догонять не надо. */
export function markReminded(row: { remind_days: number[]; reminded: number[] }, hit: number): number[] {
  const out = new Set(row.reminded ?? []);
  out.add(hit);
  if (hit >= 0) for (const d of row.remind_days ?? []) if (d > hit) out.add(d);
  return [...out].sort((a, b) => a - b);
}

/** Текст карточки. Дни — настоящий остаток до срока, а не порог: добавили за 3 дня — «через 3 дня», не «через 7». */
export function docCardText(r: { title: string; kind: string; expires_on: string }, hit: number, today: string) {
  const label = DOC_KIND_LABEL[r.kind as DocKind] ?? 'Документ';
  const date = new Date(`${r.expires_on.slice(0, 10)}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const name = r.title.trim() || label;
  if (hit < 0) return { title: `Срок истёк: ${name}`, summary: `${label} действовал до ${date}.`, priority: 0 };
  if (hit === 0) return { title: `Сегодня заканчивается: ${name}`, summary: `${label} действует до ${date} — последний день.`, priority: 0 };
  const left = Math.max(1, daysBetween(today, r.expires_on));
  const word = `${left} ${plural(left, 'день', 'дня', 'дней')}`;
  return { title: `Через ${word} заканчивается: ${name}`, summary: `${label} действует до ${date}.`, priority: left <= 7 ? 1 : 2 };
}

/** Что посоветовать сделать — по виду документа (продление занимает разное время). */
export function docAdvice(kind: string): string {
  switch (kind) {
    case 'passport': return 'Подайте на новый паспорт заранее: оформление занимает до месяца, а с истекающим паспортом не выпустят за границу.';
    case 'visa': return 'Запишитесь на подачу документов: ближайшие окна в визовых центрах бывают через несколько недель.';
    case 'insurance': return 'Продлите полис или выберите новый — без него покрытие прекратится в день окончания.';
    case 'contract': return 'Решите, продлеваете ли договор: подготовьте допсоглашение или уведомление контрагенту.';
    case 'license': return 'Проверьте, какие документы нужны для продления, и подайте их до окончания срока.';
    default: return 'Продлите документ или отметьте, что он больше не нужен.';
  }
}

// ───────────────────────────── поздравления ─────────────────────────────

export const DATE_KINDS = ['birthday', 'company', 'partnership', 'other'] as const;
export type DateKind = typeof DATE_KINDS[number];
export const DATE_KIND_LABEL: Record<DateKind, string> = {
  birthday: 'День рождения', company: 'День компании', partnership: 'Годовщина сотрудничества', other: 'Важная дата',
};

/**
 * Ближайшая дата праздника от сегодняшнего дня: сколько дней и какого года.
 * 29 февраля в невисокосный год — 28-го (как дни рождения в «Новостях»).
 */
export function nextOccurrence(month: number, day: number, today: string): { days: number; year: number; iso: string } {
  const y0 = Number(today.slice(0, 4));
  for (const y of [y0, y0 + 1]) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const d = month === 2 && day === 29 && !leap ? 28 : Math.min(day, new Date(Date.UTC(y, month, 0)).getUTCDate());
    const iso = `${y}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const days = daysBetween(today, iso);
    if (days >= 0) return { days, year: y, iso };
  }
  return { days: 366, year: y0 + 1, iso: today };
}

/** Карточка накануне (1 день) и, если накануне пропустили, — в сам день. */
export const greetingDue = (days: number) => days === 0 || days === 1;

export interface GreetingSubject {
  kind: string; title: string | null; person: string | null; client: string; years: number | null;
}

/** Повод словами: «день рождения Ивана Петрова (ООО Ромашка)», «5 лет сотрудничества с …». */
export function occasion(s: GreetingSubject): string {
  if (s.kind === 'partnership') return s.years && s.years > 0 ? `${s.years} ${plural(s.years, 'год', 'года', 'лет')} сотрудничества с «${s.client}»` : `годовщина сотрудничества с «${s.client}»`;
  if (s.kind === 'company') return s.years && s.years > 0 ? `${s.years} ${plural(s.years, 'год', 'года', 'лет')} компании «${s.client}»` : `день компании «${s.client}»`;
  if (s.kind === 'birthday') return s.person ? `день рождения: ${s.person} («${s.client}»)` : `день рождения в «${s.client}»`;
  return `${s.title || 'важная дата'} — «${s.client}»`;
}

/** Черновик без модели: короткий, без пафоса, с местом для личной строки. */
export function greetingTemplate(s: GreetingSubject): string {
  const name = s.person?.split(/\s+/)[0] ?? '';
  if (s.kind === 'birthday') {
    return `${name ? `${name}, добрый день!` : 'Добрый день!'}\n\nПоздравляем с днём рождения! Желаем здоровья, сил и интересных задач — и чтобы работа приносила радость. Спасибо, что работаете с нами.\n\nС уважением,`;
  }
  if (s.kind === 'partnership') {
    const y = s.years && s.years > 0 ? `${s.years} ${plural(s.years, 'год', 'года', 'лет')}` : 'ещё один год';
    return `${name ? `${name}, добрый день!` : 'Добрый день!'}\n\nСегодня ${y} нашего сотрудничества с «${s.client}». Спасибо за доверие и совместную работу — рады быть рядом и дальше.\n\nС уважением,`;
  }
  if (s.kind === 'company') {
    return `${name ? `${name}, добрый день!` : 'Добрый день!'}\n\nПоздравляем «${s.client}» с днём компании! Желаем роста, сильной команды и новых побед.\n\nС уважением,`;
  }
  return `${name ? `${name}, добрый день!` : 'Добрый день!'}\n\nПоздравляем: ${s.title || 'с праздником'}! Всего самого доброго вам и команде «${s.client}».\n\nС уважением,`;
}

// ───────────────────────────── договоры ─────────────────────────────

export type RiskLevel = 'high' | 'medium' | 'low';
export interface ContractRisk { level: RiskLevel; topic: string; quote: string; why: string; fix: string; source: 'rules' | 'ai' }

const RULES: { re: RegExp; level: RiskLevel; topic: string; why: string; fix: string }[] = [
  { re: /в\s+одностороннем\s+(?:внесудебном\s+)?порядке/i, level: 'high', topic: 'Одностороннее изменение или отказ', why: 'Одна сторона может менять условия или выйти из договора без согласия другой.', fix: 'Сделайте право взаимным или добавьте срок уведомления и компенсацию.' },
  { re: /неустойк[аеиуойю]|пен[ияюей]\b|пени\b|штраф/i, level: 'medium', topic: 'Неустойка и штрафы', why: 'Проверьте размер и для кого она: часто санкции есть только для одной стороны.', fix: 'Установите верхний предел (например, не более 10% цены) и зеркальную неустойку.' },
  { re: /автоматически\s+(?:продлева|пролонгир)|пролонгир|считается\s+продлённ/i, level: 'medium', topic: 'Автоматическое продление', why: 'Договор продлится сам, если вовремя не отказаться.', fix: 'Поставьте напоминание о дате отказа (раздел «Сроки документов»).' },
  { re: /100\s?%\s*(?:предоплат|аванс)|полн(?:ая|ой)\s+предоплат/i, level: 'medium', topic: 'Полная предоплата', why: 'Деньги уходят до результата — риск не получить работу или товар.', fix: 'Разбейте оплату: аванс 30–50%, остальное — после акта.' },
  { re: /ответственность[^.]{0,80}ограничива|не\s+(?:несёт|несет)\s+ответственност/i, level: 'high', topic: 'Ограничение ответственности', why: 'Контрагент снимает с себя ответственность за убытки.', fix: 'Ограничение — только для косвенных убытков, прямые возмещаются полностью.' },
  { re: /подсудност|по\s+месту\s+нахождения\s+(?:исполнителя|поставщика|арендодателя|подрядчика)|третейск/i, level: 'low', topic: 'Где решаются споры', why: 'Суд может оказаться в другом городе или третейским — это дорого и долго.', fix: 'Укажите суд по месту нахождения вашей стороны или по месту истца.' },
  { re: /исключительн\w*\s+прав|права\s+на\s+результат|интеллектуальн\w*\s+собственност/i, level: 'medium', topic: 'Права на результат работ', why: 'Проверьте, к кому переходят права на созданное — без явного пункта они остаются у исполнителя.', fix: 'Пропишите переход исключительных прав к заказчику с момента оплаты.' },
  { re: /конфиденциальн/i, level: 'low', topic: 'Конфиденциальность', why: 'Проверьте срок и санкции за разглашение — иногда они только для одной стороны.', fix: 'Сделайте обязательство взаимным и ограничьте срок (например, 3 года).' },
  { re: /без\s+(?:согласования|согласия)\s+(?:с\s+)?заказчик|привлекать\s+третьих\s+лиц|субподряд/i, level: 'low', topic: 'Третьи лица и субподряд', why: 'Исполнитель может передать работу другим без вашего ведома.', fix: 'Привлечение третьих лиц — только с письменного согласия.' },
  { re: /акт[^.]{0,60}(?:считается\s+подписанн|принят\w*\s+без\s+замечаний)|молчани/i, level: 'medium', topic: 'Молчаливая приёмка', why: 'Работа считается принятой, если вы не ответили в короткий срок.', fix: 'Увеличьте срок приёмки (10 рабочих дней) и требуйте мотивированный отказ, а не молчание.' },
];

/** Найти рискованные формулировки: правило → цитата вокруг совпадения. Повтор темы — один раз. */
export function contractRules(text: string): ContractRisk[] {
  const out: ContractRisk[] = [];
  const flat = text.replace(/\s+/g, ' ');
  for (const r of RULES) {
    const m = r.re.exec(flat);
    if (!m) continue;
    const start = Math.max(0, flat.lastIndexOf('.', m.index) + 1);
    const endDot = flat.indexOf('.', m.index + m[0].length);
    const end = endDot < 0 ? Math.min(flat.length, m.index + 220) : Math.min(endDot + 1, m.index + 320);
    const quote = flat.slice(start, end).trim().slice(0, 320);
    out.push({ level: r.level, topic: r.topic, quote, why: r.why, fix: r.fix, source: 'rules' });
  }
  return out;
}

export interface ContractReview {
  summary: string;
  parties: string[];
  subject: string | null;
  amount: string | null;
  term: string | null;
  risks: ContractRisk[];
  missing: string[];
  /** Проверено только правилами (нет ключа ИИ или модель не ответила). */
  rulesOnly: boolean;
}

const LEVELS: RiskLevel[] = ['high', 'medium', 'low'];
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Ответ модели (JSON, иногда в ```) → проверка договора; мусор — null. */
export function parseContractAi(raw: string): Omit<ContractReview, 'rulesOnly'> | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const risks: ContractRisk[] = (Array.isArray(j.risks) ? j.risks : []).slice(0, 15).map((r: any) => ({
    level: LEVELS.includes(r?.level) ? r.level : 'medium',
    topic: str(r?.topic, 120) || 'Пункт договора',
    quote: str(r?.quote, 400),
    why: str(r?.why, 400),
    fix: str(r?.fix, 400),
    source: 'ai' as const,
  })).filter((r: ContractRisk) => r.why || r.quote);
  return {
    summary: str(j.summary, 800),
    parties: (Array.isArray(j.parties) ? j.parties : []).map((p: unknown) => str(p, 160)).filter(Boolean).slice(0, 6),
    subject: str(j.subject, 300) || null,
    amount: str(j.amount, 160) || null,
    term: str(j.term, 160) || null,
    risks,
    missing: (Array.isArray(j.missing) ? j.missing : []).map((p: unknown) => str(p, 200)).filter(Boolean).slice(0, 10),
  };
}

/** Свести модель и правила: тема правила, которую модель уже назвала, не дублируется. */
export function mergeRisks(ai: ContractRisk[], rules: ContractRisk[]): ContractRisk[] {
  const seen = (r: ContractRisk) => {
    const key = r.topic.toLowerCase().split(/\s+/)[0].slice(0, 6);
    return ai.some((a) => `${a.topic} ${a.why}`.toLowerCase().includes(key));
  };
  const all = [...ai, ...rules.filter((r) => !seen(r))];
  return all.sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
}

export function looksLikeContract(text: string): boolean {
  return /договор|соглашени|контракт|оферт|сторон[аы]|исполнитель|заказчик|арендодатель|поставщик/i.test(text.slice(0, 20000));
}

// ───────────────────────────── чеки ─────────────────────────────

export const RECEIPT_CATEGORIES = ['taxi', 'transport', 'hotel', 'food', 'office', 'fuel', 'communication', 'other'] as const;
export const RECEIPT_CATEGORY_LABEL: Record<string, string> = {
  taxi: 'Такси', transport: 'Билеты и транспорт', hotel: 'Проживание', food: 'Питание', office: 'Канцелярия и офис',
  fuel: 'Топливо', communication: 'Связь и интернет', other: 'Прочее',
};

export interface ReceiptFields {
  spentOn: string | null; seller: string | null; sellerInn: string | null;
  total: number | null; vat: number | null; currency: string; category: string;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100) / 100;
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s| /g, '').replace(/[^\d,.-]/g, '').replace(',', '.');
  const n = Number(s);
  return s && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/** Дата в любом из привычных видов → YYYY-MM-DD; не дата или из будущего (> завтра) — null. */
export function normDate(v: unknown, today: string): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let y: number; let m: number; let d: number;
  let r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (r) { y = +r[1]; m = +r[2]; d = +r[3]; } else {
    r = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
    if (!r) return null;
    d = +r[1]; m = +r[2]; y = +r[3] < 100 ? 2000 + +r[3] : +r[3];
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return daysBetween(today, iso) > 1 ? null : iso;
}

/** Ответ модели по чеку → поля. Без суммы чек не распознан (null). */
export function parseReceiptAi(raw: string, today: string): ReceiptFields | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const total = num(j?.total);
  if (total === null || total <= 0) return null;
  const vat = num(j?.vat);
  const inn = typeof j?.inn === 'string' ? j.inn.replace(/\D/g, '') : '';
  const cur = typeof j?.currency === 'string' && /^[A-Z]{3}$/.test(j.currency.trim().toUpperCase()) ? j.currency.trim().toUpperCase() : 'RUB';
  return {
    spentOn: normDate(j?.date, today),
    seller: str(j?.seller, 200) || null,
    sellerInn: inn.length === 10 || inn.length === 12 ? inn : null,
    total,
    vat: vat !== null && vat >= 0 && vat < total ? vat : null,
    currency: cur,
    category: (RECEIPT_CATEGORIES as readonly string[]).includes(j?.category) ? j.category : 'other',
  };
}

const money = (n: number | null) => (n === null ? '' : n.toFixed(2).replace('.', ','));

/** Строки авансового отчёта для Excel: шапка, чеки по дате, итог по категориям и всего. */
export function advanceReportRows(
  rows: { spent_on: string | null; seller: string | null; seller_inn: string | null; total: string | number | null; vat: string | number | null; currency: string; category: string | null; purpose: string | null }[],
  head: { person: string; from: string | null; to: string | null },
): string[][] {
  const period = head.from || head.to ? `${head.from ? new Date(`${head.from}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC' }) : '…'} — ${head.to ? new Date(`${head.to}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC' }) : '…'}` : 'за всё время';
  const out: string[][] = [
    ['Авансовый отчёт'],
    ['Подотчётное лицо', head.person],
    ['Период', period],
    [],
    ['№', 'Дата', 'Продавец', 'ИНН продавца', 'Категория', 'Назначение', 'Сумма', 'в т. ч. НДС', 'Валюта'],
  ];
  const sorted = [...rows].sort((a, b) => String(a.spent_on ?? '').localeCompare(String(b.spent_on ?? '')));
  const byCat = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  sorted.forEach((r, i) => {
    const t = num(r.total); const v = num(r.vat);
    out.push([
      String(i + 1),
      r.spent_on ? new Date(`${String(r.spent_on).slice(0, 10)}T12:00:00Z`).toLocaleDateString('ru-RU', { timeZone: 'UTC' }) : '',
      r.seller ?? '', r.seller_inn ?? '', RECEIPT_CATEGORY_LABEL[r.category ?? 'other'] ?? 'Прочее', r.purpose ?? '',
      money(t), money(v), r.currency,
    ]);
    if (t !== null) {
      const cat = RECEIPT_CATEGORY_LABEL[r.category ?? 'other'] ?? 'Прочее';
      const m = byCat.get(r.currency) ?? new Map<string, number>();
      m.set(cat, (m.get(cat) ?? 0) + t);
      byCat.set(r.currency, m);
      totals.set(r.currency, (totals.get(r.currency) ?? 0) + t);
    }
  });
  out.push([]);
  for (const [cur, m] of byCat) {
    for (const [cat, sum] of m) out.push(['', '', '', '', cat, 'итого по категории', money(Math.round(sum * 100) / 100), '', cur]);
  }
  for (const [cur, sum] of totals) out.push(['', '', '', '', 'ВСЕГО', '', money(Math.round(sum * 100) / 100), '', cur]);
  out.push([]);
  out.push(['Чеков', String(sorted.length)]);
  return out;
}
