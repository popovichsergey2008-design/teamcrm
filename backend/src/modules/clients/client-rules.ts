/**
 * Правила раздела «Клиенты» (ТЗ-17) — чистые функции, время передаётся снаружи.
 *
 * Здесь живёт всё, что легко сломать молча: нормализация для поиска дублей, стадии
 * сделок, «здоровье» клиента и сводка с источниками. Сводку собираем ПРАВИЛАМИ, а не
 * моделью (решение заказчика): каждая строка — факт с источником, «клиент недоволен»
 * без основания не появится никогда (п. 57).
 */

export const CLIENT_TYPES = ['company', 'person'] as const;
export const CLIENT_STATUSES = ['lead', 'active', 'paused', 'inactive', 'lost'] as const;
export const CLIENT_SOURCES = ['website', 'referral', 'advertising', 'telegram', 'email', 'manual', 'import', 'partner', 'other'] as const;
export const MEMBER_ROLES = ['account', 'sales', 'pm', 'support', 'watcher'] as const;
export const FILE_CATEGORIES = ['contract', 'invoice', 'proposal', 'presentation', 'technical', 'other'] as const;
/** Стадии сделки — стандартный список (решение заказчика), «new» — прежнее значение по умолчанию. */
export const DEAL_STAGES = ['new', 'negotiation', 'proposal', 'approval', 'won', 'lost'] as const;
export const OPEN_DEAL_STAGES = ['new', 'negotiation', 'proposal', 'approval'];
/** Сегменты по умолчанию — подсказка, а не закрытый список (п. 7). */
export const DEFAULT_SEGMENTS = ['VIP', 'Key Account', 'Standard', 'Potential', 'Partner', 'Supplier'];

export function normalizeEmail(v?: string | null): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  return s.includes('@') ? s : null;
}

/**
 * Телефон к виду +79991234567, где это можно сделать уверенно (п. 76). Российский
 * «8…» и «7…» на 11 цифр приводим к +7; остальное — цифры с плюсом, как есть.
 */
export function normalizePhone(v?: string | null): string | null {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length < 6) return null;
  if (digits.length === 11 && (digits.startsWith('8') || digits.startsWith('7')) && !raw.startsWith('+') ) {
    digits = `7${digits.slice(1)}`;
  }
  if (digits.length === 10 && digits.startsWith('9')) digits = `7${digits}`;
  return `+${digits}`;
}

/** Домен из сайта или почты: нижний регистр, без www и пути (п. 76). Почтовые сервисы — не домен компании. */
const PUBLIC_MAIL = new Set(['gmail.com', 'mail.ru', 'yandex.ru', 'ya.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'rambler.ru', 'outlook.com', 'hotmail.com', 'icloud.com', 'yahoo.com', 'proton.me', 'protonmail.com']);
export function normalizeDomain(v?: string | null): string | null {
  let s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('@')) s = s.split('@').pop() ?? '';
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  if (!s.includes('.') || PUBLIC_MAIL.has(s)) return null;
  return s;
}

/** Название без формы собственности, кавычек и регистра — «ООО «Ромашка»» = «Ромашка». */
// По словам, а не регуляркой с \b: граница слова в JS не видит кириллицу (грабли).
const LEGAL_FORMS = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'ип', 'нко', 'ано', 'llc', 'ltd', 'inc', 'gmbh', 'ag', 'corp', 'co', 'plc', 'sa', 'bv', 'oy', 'ug']);
export function normalizeName(v?: string | null): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[«»"'`„“”]/g, ' ')
    .replace(/[.,;:!?()[\]{}\-–—_/\\|]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEGAL_FORMS.has(w))
    .join(' ');
}

export interface DuplicateSignal {
  clientId: string;
  name: string;
  /** что совпало: email · phone · tax_id · domain · name */
  matched: string[];
  similarity: number;
}

/** Достаточно ли похоже имя: совпадение целиком или тесная нечёткая близость (п. 77). */
export function nameLooksSame(similarity: number, a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return similarity >= 0.6;
}

// ── «здоровье» клиента (п. 43): только с понятными правилами ───────────────────
export interface HealthInput {
  overdueTasks: number;
  daysSinceActivity: number | null;
  /** сколько дней открытая сделка не меняла стадию; null — открытых нет */
  dealStalledDays: number | null;
  status: string;
  archived: boolean;
}

export interface Health {
  level: 'healthy' | 'attention' | 'risk' | null;
  signals: string[];
}

export function clientHealth(h: HealthInput): Health {
  if (h.archived || h.status === 'lost' || h.status === 'inactive') return { level: null, signals: [] };
  const signals: string[] = [];
  let score = 0;
  if (h.overdueTasks > 0) { signals.push(`просрочено задач: ${h.overdueTasks}`); score += h.overdueTasks > 2 ? 2 : 1; }
  if (h.daysSinceActivity != null && h.daysSinceActivity >= 21) { signals.push(`нет активности ${h.daysSinceActivity} дн.`); score += 2; }
  else if (h.daysSinceActivity != null && h.daysSinceActivity >= 14) { signals.push(`нет активности ${h.daysSinceActivity} дн.`); score += 1; }
  if (h.dealStalledDays != null && h.dealStalledDays >= 14) { signals.push(`сделка не двигалась ${h.dealStalledDays} дн.`); score += 1; }
  if (score >= 3) return { level: 'risk', signals };
  if (score >= 1) return { level: 'attention', signals };
  return { level: 'healthy', signals };
}

// ── сводка с источниками (п. 21–22) ──────────────────────────────────────────────
export interface SummaryInput {
  now: Date;
  status: string;
  lastActivityAt: Date | string | null;
  lastActivityTitle: string | null;
  openDeals: { id: string; title: string; amount: number | null; currency: string; stage: string; updatedAt: Date | string }[];
  openTasks: number;
  overdueTasks: { id: string; title: string }[];
  nextMeeting: { id: string; title: string; startsAt: Date | string } | null;
  nextAction: { text: string; at: Date | string | null } | null;
}

export interface SummaryLine {
  text: string;
  /** источник: task:15 · deal:4 · event:7 · client */
  sources: string[];
  tone?: 'risk' | 'info';
}

const STATUS_RU: Record<string, string> = {
  lead: 'Клиент — лид', active: 'Клиент активен', paused: 'Работа на паузе', inactive: 'Клиент неактивен', lost: 'Клиент потерян',
};

const daysBetween = (a: Date, b: Date) => Math.floor((a.getTime() - b.getTime()) / 86_400_000);
const money = (v: number, cur: string) => `${new Intl.NumberFormat('ru-RU').format(Math.round(v))} ${cur === 'RUB' ? '₽' : cur === 'EUR' ? '€' : cur === 'USD' ? '$' : cur}`;
const dayName = (d: Date) => new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);

export function clientSummary(s: SummaryInput): { lines: SummaryLine[]; risks: SummaryLine[]; enough: boolean } {
  const lines: SummaryLine[] = [];
  const risks: SummaryLine[] = [];
  lines.push({ text: `${STATUS_RU[s.status] ?? 'Клиент'}.`, sources: ['client'] });

  if (s.lastActivityAt) {
    const d = Math.max(0, daysBetween(s.now, new Date(s.lastActivityAt)));
    const when = d === 0 ? 'сегодня' : d === 1 ? 'вчера' : `${d} дн. назад`;
    lines.push({ text: `Последняя активность: ${when}${s.lastActivityTitle ? ` — ${s.lastActivityTitle}` : ''}.`, sources: ['activity'] });
    if (d >= 21) risks.push({ text: `Нет активности ${d} дней.`, sources: ['activity'], tone: 'risk' });
  }

  for (const deal of s.openDeals.slice(0, 3)) {
    lines.push({ text: `Открытая сделка «${deal.title}»${deal.amount ? `: ${money(deal.amount, deal.currency)}` : ''}.`, sources: [`deal:${deal.id}`] });
    const stalled = daysBetween(s.now, new Date(deal.updatedAt));
    if (stalled >= 14) risks.push({ text: `Сделка «${deal.title}» не меняла стадию ${stalled} дней.`, sources: [`deal:${deal.id}`], tone: 'risk' });
  }

  if (s.openTasks > 0) {
    lines.push({ text: `Открытых задач: ${s.openTasks}${s.overdueTasks.length ? `, просрочено: ${s.overdueTasks.length}` : ''}.`, sources: s.overdueTasks.slice(0, 3).map((t) => `task:${t.id}`) });
  }
  for (const t of s.overdueTasks.slice(0, 2)) {
    risks.push({ text: `Просрочена задача «${t.title}».`, sources: [`task:${t.id}`], tone: 'risk' });
  }

  if (s.nextMeeting) {
    lines.push({ text: `Следующая встреча — ${dayName(new Date(s.nextMeeting.startsAt))}: «${s.nextMeeting.title}».`, sources: [`event:${s.nextMeeting.id}`] });
  }
  if (s.nextAction?.text) {
    lines.push({ text: `Следующее действие: ${s.nextAction.text}${s.nextAction.at ? ` (до ${new Date(s.nextAction.at).toLocaleDateString('ru-RU')})` : ''}.`, sources: ['client'] });
  } else if (!s.nextMeeting) {
    risks.push({ text: 'По клиенту нет следующего действия.', sources: ['client'], tone: 'risk' });
  }

  // Кроме статуса ничего не нашлось — честно говорим, что выводов нет (п. 22).
  const enough = lines.length > 1;
  return { lines, risks, enough };
}
