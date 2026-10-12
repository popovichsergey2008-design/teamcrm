/**
 * Гостевой портал (ТЗ-28) — чистые правила: бренд, черновик договорённостей,
 * проверка перевода, ссылки «добавить в календарь», состояние экрана после встречи.
 */

export type AgreementSide = 'ours' | 'client' | 'both' | 'unassigned';
export const SIDES: AgreementSide[] = ['ours', 'client', 'both', 'unassigned'];
export const FEEDBACK_KINDS = ['question', 'correction', 'comment'] as const;
export const GUEST_EVENTS = ['opened', 'prejoin_completed', 'joined', 'summary_viewed', 'acknowledged', 'feedback', 'file_downloaded', 'cta_clicked', 'calendar_added'] as const;
export const POLICY_VERSION = 'rec-v1';

// ── бренд ──

const hex = (s: string) => /^#?[0-9a-f]{6}$/i.test(s.trim()) ? s.trim().replace(/^#?/, '#').toLowerCase() : null;
const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
export const contrastWithWhite = (h: string) => 1.05 / (luminance(h) + 0.05);

/**
 * Акцент бренда, на котором белый текст кнопки читается (AA, 4.5:1, п. 98).
 * Светлый фирменный цвет не ломает доступность: затемняем его, пока не прочтётся.
 */
export function safeAccent(input: string | null | undefined): string | null {
  const h = input ? hex(input) : null;
  if (!h) return null;
  let r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  const out = () => `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
  for (let i = 0; i < 40 && contrastWithWhite(out()) < 4.5; i++) {
    r *= 0.92; g *= 0.92; b *= 0.92;
  }
  return out();
}

export const normalizeHex = (s: string | null | undefined) => (s ? hex(s) : null);

/** Язык гостя: из приглашения или браузера, «en-US» → «en». Неизвестный — русский. */
export function guestLanguage(raw: string | null | undefined): string {
  const l = String(raw || '').toLowerCase().slice(0, 2);
  return /^[a-z]{2}$/.test(l) ? l : 'ru';
}

// ── черновик договорённостей ──

export interface DraftAgreement {
  text: string;
  side: AgreementSide;
  deadlineAt: string | null;
  sourceDecisionId: string | null;
  sourceDraftId: string | null;
}

const norm = (s: string) => s.toLowerCase().replace(/[«»"'.,;:!?—–-]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Договорённости из того же, что во внутреннем разборе (п. 93): решения встречи — общие,
 * поручения со встречи — наша сторона. Отклонённые поручения не берём, повторы схлопываем.
 * Сторону и формулировку хозяин поправит перед публикацией.
 */
export function draftAgreements(
  decisions: { id: string; text: string }[],
  drafts: { id: string; title: string; deadlineAt: string | Date | null; status: string; assigneeId: string | null }[],
): DraftAgreement[] {
  const out: DraftAgreement[] = [];
  const seen = new Set<string>();
  const push = (a: DraftAgreement) => {
    const k = norm(a.text);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(a);
  };
  for (const d of decisions) {
    push({ text: d.text.replace(/\s+/g, ' ').trim().slice(0, 500), side: 'both', deadlineAt: null, sourceDecisionId: d.id, sourceDraftId: null });
  }
  for (const t of drafts) {
    if (t.status === 'rejected') continue;
    push({
      text: t.title.replace(/\s+/g, ' ').trim().slice(0, 500),
      side: t.assigneeId ? 'ours' : 'unassigned',
      deadlineAt: t.deadlineAt ? new Date(t.deadlineAt).toISOString() : null,
      sourceDecisionId: null, sourceDraftId: t.id,
    });
  }
  return out.slice(0, 20);
}

/** Текст «Кратко» без модели: из тех же договорённостей. */
export function rulesSummary(title: string, agreements: { text: string }[], language: string): string {
  if (language === 'en') {
    return agreements.length
      ? `Thank you for the meeting "${title}". Below are the agreements we recorded and the next steps.`
      : `Thank you for the meeting "${title}".`;
  }
  return agreements.length
    ? `Спасибо за встречу «${title}». Ниже — договорённости, которые мы зафиксировали, и следующие шаги.`
    : `Спасибо за встречу «${title}».`;
}

const numbersOf = (s: string) => (s.match(/\d+(?:[:.,]\d+)?/g) ?? []).map((x) => x.replace(',', '.')).sort();

/**
 * Ответ модели: {summary, agreements[]}. Перевод договорённостей принимаем, только если
 * их столько же и в каждой те же числа — даты, суммы и сроки не должны поплыть (п. 71).
 */
export function parseModelDraft(raw: string, originals: string[]): { summary: string; agreements: string[] | null } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: { summary?: unknown; agreements?: unknown };
  try { j = JSON.parse(m[0]); } catch { return null; }
  const summary = typeof j.summary === 'string' ? j.summary.replace(/\s+/g, ' ').trim().slice(0, 1500) : '';
  if (!summary) return null;
  const list = Array.isArray(j.agreements) ? j.agreements.map((x) => String(x ?? '').trim()) : null;
  const ok = !!list && list.length === originals.length
    && list.every((t, i) => t.length > 0 && t.length <= 500 && numbersOf(t).join('|') === numbersOf(originals[i]).join('|'));
  return { summary, agreements: ok ? list : null };
}

// ── календарь (п. 42–43) ──

const gcalStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function googleCalendarUrl(e: { title: string; startsAt: Date; endsAt: Date; details?: string | null }): string {
  const p = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates: `${gcalStamp(e.startsAt)}/${gcalStamp(e.endsAt)}` });
  if (e.details) p.set('details', e.details);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

export function outlookCalendarUrl(e: { title: string; startsAt: Date; endsAt: Date; details?: string | null }): string {
  const p = new URLSearchParams({
    path: '/calendar/action/compose', rru: 'addevent', subject: e.title,
    startdt: e.startsAt.toISOString(), enddt: e.endsAt.toISOString(),
  });
  if (e.details) p.set('body', e.details);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${p.toString()}`;
}

// ── что показать гостю после встречи (п. 28, 61) ──

export type PostcallState = 'none' | 'processing' | 'ready' | 'expired';

/**
 * - опубликован и не истёк — `ready`;
 * - опубликован, но срок показа вышел — `expired`;
 * - встреча была (запись есть или гость заходил), протокола ещё нет — `processing`;
 * - иначе — `none` (встречи ещё не было).
 */
export function postcallState(i: { publishedAt: Date | null; summaryDays: number; meetingHappened: boolean; now: Date }): PostcallState {
  if (i.publishedAt) {
    const until = new Date(i.publishedAt).getTime() + i.summaryDays * 86_400_000;
    return i.now.getTime() > until ? 'expired' : 'ready';
  }
  return i.meetingHappened ? 'processing' : 'none';
}
