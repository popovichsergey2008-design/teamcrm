import { declineName, firstName, plural } from '../../common/text/ru-grammar';

/**
 * Утренний аудио-кофе руководителя (#1525, фича 6) — чистые правила, без базы и часов.
 *
 * Форма дословно по документу заказчика:
 *   «Доброе утро, Борис! На связи ваш ассистент QEVO. Вот главное на сегодня:
 *    - Вчера на созвоне с Сергеем согласовали структуру гостевых ссылок.
 *    - Сегодня горящий дедлайн у Глеба по верстке.
 *    - В техподдержке закрыты все 100 процентов вопросов.
 *    Черновики для утренней планерки я уже добавил в ваши задачи. Хорошего дня!»
 * Около 45 секунд голосом — до восьми пунктов и около 110 слов всего. Фразу про
 * черновики говорим, только если они правда добавлены.
 */

export interface CoffeeFacts {
  /** полное имя руководителя */
  name: string | null;
  /** решения вчерашних созвонов, видимых ему; peer — с кем был созвон (не он сам) */
  decisions: { text: string; peer: string | null; meetingTitle: string | null }[];
  /** горящие сегодня задачи команды (срок сегодня, задача у исполнителя) */
  hot: { title: string; who: string | null }[];
  /** всего таких задач (hot — только первые) */
  hotTotal: number;
  /** просрочено у исполнителей (ТЗ-30: сданное на проверку — не просрочка) */
  overdue: number;
  /** обращения в службу заботы за вчера; null или total = 0 — пункт не говорим */
  support: { total: number; closed: number } | null;
  waiting: { proposals: number; approvals: number };
  meetingsToday: number;
  firstMeeting: { title: string; time: string } | null;
  overloaded: string[];
  /** сколько черновиков планерки лежит у него на сегодня */
  drafts: number;
}

export interface Coffee {
  intro: string;
  items: string[];
  outro: string;
  /** текст для синтеза — без кавычек-ёлочек и тире, они читаются паузами и мусором */
  speech: string;
}

const MAX_ITEMS = 8;
/** ~45 секунд: синтез говорит около 2,4 слова в секунду */
const MAX_WORDS = 110;

const clean = (s: string, max = 110) => {
  const t = String(s ?? '').replace(/[«»"]/g, '').replace(/\s+/g, ' ').trim().replace(/[.!;:,]+$/u, '');
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
/** Первая буква строчная, если это не аббревиатура и не имя собственное в начале («API», «QEVO»). */
const lc = (s: string) => (/^\p{Lu}\p{Ll}/u.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** «Вчера на созвоне с Сергеем согласовали: …»; решение-глагол — «решили заложить комиссию». */
export function decisionLine(d: CoffeeFacts['decisions'][number]): string {
  const text = lc(clean(d.text).replace(/^(решено|решили|договорились|согласовали)[\s:,–—-]+/iu, ''));
  const peer = d.peer ? firstName(d.peer) : '';
  const where = peer ? `на созвоне с ${declineName(peer, 'ins')}` : d.meetingTitle ? `на созвоне «${clean(d.meetingTitle, 60)}»` : 'на созвоне';
  const verb = /^\p{L}+(ть|ти|ться|тись|чь)(?![\p{L}])/u.test(text) ? `решили ${text}` : `согласовали: ${text}`;
  return `Вчера ${where} ${verb}.`;
}

export function hotLine(h: CoffeeFacts['hot'][number]): string {
  const who = h.who ? firstName(h.who) : '';
  return who
    ? `Сегодня горящий дедлайн у ${declineName(who, 'gen')} по задаче «${clean(h.title, 70)}».`
    : `Сегодня горящий дедлайн по задаче «${clean(h.title, 70)}».`;
}

/** «В техподдержке закрыты все 100 процентов вопросов» / «… закрыты 80 процентов вопросов». */
export function supportLine(s: CoffeeFacts['support']): string | null {
  if (!s || !s.total) return null;
  const pct = Math.round((Math.min(s.closed, s.total) / s.total) * 100);
  if (pct === 100) return 'В техподдержке закрыты все 100 процентов вопросов.';
  return `В техподдержке закрыты ${pct} ${plural(pct, 'процент', 'процента', 'процентов')} вопросов.`;
}

export function morningCoffee(f: CoffeeFacts): Coffee {
  const name = firstName(f.name);
  const intro = `Доброе утро${name ? `, ${name}` : ''}! На связи ваш ассистент QEVO. Вот главное на сегодня:`;
  const items: string[] = [];
  for (const d of f.decisions.slice(0, 2)) items.push(decisionLine(d));
  for (const h of f.hot.slice(0, 2)) items.push(hotLine(h));
  const moreHot = f.hotTotal - Math.min(2, f.hot.length);
  if (moreHot > 0) items.push(`Ещё ${moreHot} ${plural(moreHot, 'срок', 'срока', 'сроков')} у команды тоже сегодня.`);
  if (f.overdue > 0) items.push(`Просрочено ${f.overdue} ${plural(f.overdue, 'задача', 'задачи', 'задач')} команды.`);
  const sup = supportLine(f.support);
  if (sup) items.push(sup);
  const w = f.waiting;
  if (w.approvals || w.proposals) {
    const parts = [
      w.approvals ? `${w.approvals} ${plural(w.approvals, 'согласование', 'согласования', 'согласований')}` : '',
      w.proposals ? `${w.proposals} ${plural(w.proposals, 'предложение', 'предложения', 'предложений')} секретаря` : '',
    ].filter(Boolean);
    items.push(`Ждут вашего решения: ${parts.join(' и ')}.`);
  }
  if (f.meetingsToday) {
    const first = f.firstMeeting ? `, первая в ${f.firstMeeting.time} — «${clean(f.firstMeeting.title, 60)}»` : '';
    items.push(`Сегодня ${f.meetingsToday} ${plural(f.meetingsToday, 'встреча', 'встречи', 'встреч')}${first}.`);
  }
  if (f.overloaded.length) {
    const names = f.overloaded.slice(0, 3).map((n) => firstName(n) || n);
    items.push(`${f.overloaded.length === 1 ? 'Перегружен' : 'Перегружены'}: ${names.join(', ')}${f.overloaded.length > 3 ? ` и ещё ${f.overloaded.length - 3}` : ''}.`);
  }
  if (!items.length) items.push('Ничего не горит: сроков на сегодня и ждущих решений нет.');
  const outro = f.drafts > 0 ? 'Черновики для утренней планерки я уже добавил в ваши задачи. Хорошего дня!' : 'Хорошего дня!';

  const kept = items.slice(0, MAX_ITEMS);
  // лишнее по словам срезаем с конца: порядок пунктов — по важности
  while (kept.length > 1 && words([intro, ...kept, outro].join(' ')) > MAX_WORDS) kept.pop();
  return { intro, items: kept, outro, speech: speechOf([intro, ...kept, outro]) };
}

export function speechOf(parts: string[]): string {
  return parts.join(' ')
    .replace(/[«»"]/g, '')
    .replace(/\s+—\s+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────── черновики планерки ───────────────────────

export interface StandupInput {
  /** горящие и просроченные задачи команды — уже по важности */
  tasks: { id: string; projectId: string; title: string; who: string | null; overdue: boolean }[];
  blocked: { id: string; projectId: string; title: string; who: string | null }[];
  decisions: { id: string; projectId: string | null; text: string; meetingId: string | null; meetingTitle: string | null }[];
}

export interface StandupDraft {
  /** ключ черновика: повторный тик не создаёт второй такой же */
  ref: string;
  title: string;
  description: string;
  projectId: string;
  link: string | null;
  /** задача, поставленная из черновика (null — ещё черновик) */
  taskId: string | null;
}

const MAX_DRAFTS = 6;

/**
 * Повестка утренней планерки: горящее и просроченное у команды, блокеры, вчерашние
 * решения. Каждый пункт — черновик задачи руководителю «в 1 клик»; без проекта
 * задача не ставится (ТЗ-31), такие решения пропускаем.
 */
export function standupDrafts(i: StandupInput): StandupDraft[] {
  const out: StandupDraft[] = [];
  const seen = new Set<string>();
  const add = (d: Omit<StandupDraft, 'taskId'>) => {
    if (seen.has(d.ref) || out.length >= MAX_DRAFTS) return;
    seen.add(d.ref);
    out.push({ ...d, taskId: null });
  };
  const who = (n: string | null) => (n ? ` — ${firstName(n) || n}` : '');
  for (const t of i.tasks.slice(0, 4)) {
    add({
      ref: `task:${t.id}`,
      title: `Планерка: ${t.overdue ? 'просрочено' : 'срок сегодня'} «${clean(t.title, 120)}»${who(t.who)}`.slice(0, 250),
      description: `Пункт утренней планерки — подготовил секретарь QEVO.\n${t.overdue ? 'Срок задачи прошёл' : 'Срок задачи — сегодня'}; обсудить, что мешает и кто поможет.`,
      projectId: t.projectId, link: `/projects/${t.projectId}/task/${t.id}`,
    });
  }
  for (const t of i.blocked.slice(0, 2)) {
    add({
      ref: `task:${t.id}`,
      title: `Планерка: снять блокер «${clean(t.title, 120)}»${who(t.who)}`.slice(0, 250),
      description: 'Пункт утренней планерки — подготовил секретарь QEVO.\nЗадача заблокирована; решить, кто и как её разблокирует.',
      projectId: t.projectId, link: `/projects/${t.projectId}/task/${t.id}`,
    });
  }
  for (const d of i.decisions.slice(0, 3)) {
    if (!d.projectId) continue;
    add({
      ref: `decision:${d.id}`,
      title: `Планерка: проверить исполнение решения «${clean(d.text, 120)}»`.slice(0, 250),
      description: `Пункт утренней планерки — подготовил секретарь QEVO.\nРешение вчерашнего созвона${d.meetingTitle ? ` «${clean(d.meetingTitle, 80)}»` : ''}; проверить, что по нему уже сделано.`,
      projectId: d.projectId, link: d.meetingId ? `/meetings/${d.meetingId}` : null,
    });
  }
  return out;
}

/** Сколько после назначенного времени ещё не поздно прислать бриф (проспали тик, выкладка). */
const LATE_WINDOW_MIN = 4 * 60;

/** Пора ли брифу: местное время не раньше назначенного и не позже чем через 4 часа; выходные — если человек не просил. */
export function briefDue(at: string | null, local: { hour: number; minute: number; dow: number }, weekdaysOnly: boolean): boolean {
  if (!at || !/^\d{1,2}:\d{2}$/.test(at)) return false;
  if (weekdaysOnly && (local.dow === 0 || local.dow === 6)) return false;
  const [h, m] = at.split(':').map(Number);
  const diff = local.hour * 60 + local.minute - (h * 60 + m);
  return diff >= 0 && diff < LATE_WINDOW_MIN;
}
