import { createHash } from 'crypto';

/**
 * Персональный брифинг «Фокуса дня» (ТЗ-27) — чистые правила, время передаётся снаружи.
 *
 * Здесь решается всё, что можно проверить: какие факты попадут в текст, в каком
 * порядке и сколько их. Модель (если есть ключ) только переписывает готовый текст
 * человечнее — и её вариант принимается, лишь если в нём нет ни одного числа и ни
 * одного названия, которых нет в тексте правил (п. 64: факты — бэкенд, слова — модель).
 *
 * Тройку брифинг не выбирает (п. 17, 65): он получает уже собранный план и объясняет
 * его. Если сегодня горит то, что в тройку не вошло, это говорится прямо — «в план не
 * вошло», а не молча (п. 18).
 */
export const BRIEF_PROMPT_VERSION = 'focus_brief_v1';
export const FACTS_VERSION = 'brief_facts_v1';

export type BriefLength = 'short' | 'normal';

export interface BriefTopItem {
  itemId: string;
  rank: number;
  kind: 'task' | 'review' | 'approval';
  title: string;
  taskId: string | null;
  projectId: string | null;
  projectName: string | null;
  /** местная дата срока (YYYY-MM-DD) или null */
  deadlineDate: string | null;
  done: boolean;
}

export interface BriefFacts {
  /** сегодня по поясу человека */
  today: string;
  dayOff: boolean;
  boss: boolean;
  top: BriefTopItem[];
  /** вчерашние встречи человека с решениями — только видимые ему */
  meetings: { id: string; title: string; at: string; decisions: string[] }[];
  /** вчерашние разборы созвонов, которые ещё ждут его */
  postcall: { meetingId: string; title: string }[];
  /** его невыполненные обещания, срок которых наступил */
  commitments: { id: string; action: string; taskId: string | null; projectId: string | null; sourceLabel: string; sourceLink: string | null }[];
  /** ТЗ-30: моя работа сдана и ждёт проверки — не просрочка */
  submittedWaiting?: number;
  /** своё со сроком сегодня/просроченное, не попавшее в тройку */
  dueOutside: { taskId: string; projectId: string; title: string; overdue: boolean }[];
  /** ждут его решения: предложения секретаря и согласования */
  waiting: { proposals: number; approvals: number };
  meetingsToday: number;
  firstMeeting: { id: string; title: string; time: string; minutesLeft: number } | null;
  /** обязательные к прочтению объявления, которые он не подтвердил */
  announcements: { id: string; title: string }[];
  /** письма клиентам после встреч, ждущие его (null — блок выключен) */
  clients: { followups: number } | null;
  /** перегруженные люди (null — сигналы команды выключены или не положены по роли) */
  team: { overloaded: string[] } | null;
}

export interface BriefSource {
  id: string;
  kind: 'task' | 'meeting' | 'postcall' | 'commitment' | 'decisions' | 'calendar' | 'news' | 'clients' | 'team';
  label: string;
  link: string | null;
}

export interface BriefSentence {
  text: string;
  refs: string[];
}

export interface BriefAction {
  kind: 'decisions' | 'postcall' | 'meeting' | 'news' | 'clients';
  label: string;
  link: string;
}

export interface ComposedBrief {
  sentences: BriefSentence[];
  sources: BriefSource[];
  actions: BriefAction[];
  /** темы, о которых говорит текст: ключи задач — для сверки с «изменением днём» */
  mentions: string[];
}

const q = (s: string, max = 70) => {
  const t = s.replace(/[«»"]/g, '').replace(/\s+/g, ' ').trim();
  return `«${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}»`;
};

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

const taskLink = (projectId: string | null, taskId: string | null) => (projectId && taskId ? `/projects/${projectId}/task/${taskId}` : null);

/** Порядок разделов в тексте: вчера → сегодня → решения → встречи → прочее → итог. */
const ORDER = ['yesterday', 'today', 'promise', 'decide', 'calendar', 'news', 'clients', 'team'] as const;
type Section = (typeof ORDER)[number];

/**
 * Собрать брифинг. Предложений по существу — не больше 4 («коротко» — 2), плюс
 * итоговая строка про тройку: 3–5 предложений, 10–20 секунд чтения (п. 8).
 * Что не влезло, отбрасывается по важности, а не по порядку.
 */
export function composeBrief(f: BriefFacts, length: BriefLength = 'normal'): ComposedBrief {
  const sources: BriefSource[] = [];
  const actions: BriefAction[] = [];
  const mentions: string[] = [];
  const src = (s: Omit<BriefSource, 'id'>) => {
    const found = sources.find((x) => x.kind === s.kind && x.link === s.link && x.label === s.label);
    if (found) return found.id;
    const id = `s${sources.length + 1}`;
    sources.push({ id, ...s });
    return id;
  };
  // кандидаты: [важность, раздел, предложение, действие]
  const cand: { weight: number; section: Section; s: BriefSentence; action?: BriefAction }[] = [];

  const active = f.top.filter((i) => !i.done);
  const hot = active.filter((i) => i.deadlineDate && i.deadlineDate <= f.today);

  if (f.dayOff) {
    // выходной: без делового стресса (п. 74) — только то, что действительно горит
    const s: BriefSentence[] = [{ text: 'Сегодня у вас выходной.', refs: [] }];
    if (hot.length) {
      const i = hot[0];
      s.push({
        text: `Но срок у ${q(i.title)} — ${i.deadlineDate! < f.today ? 'уже прошёл' : 'сегодня'}.`,
        refs: [src({ kind: 'task', label: `${i.title} · ${i.deadlineDate! < f.today ? 'просрочено' : 'срок сегодня'}`, link: taskLink(i.projectId, i.taskId) })],
      });
      if (i.taskId) mentions.push(`task:${i.taskId}`);
    } else {
      s.push({ text: 'Критичных событий нет.', refs: [] });
    }
    return { sentences: s, sources, actions, mentions };
  }

  // ── вчера: решения встреч и неразобранные итоги ──
  const withDecisions = f.meetings.filter((m) => m.decisions.length);
  if (withDecisions.length === 1) {
    const m = withDecisions[0];
    cand.push({
      weight: 60, section: 'yesterday',
      s: { text: `Вчера на встрече ${q(m.title, 50)} решили: ${m.decisions[0].replace(/[.!]+$/, '')}.`, refs: [src({ kind: 'meeting', label: `${m.title} · вчера ${m.at}`, link: `/meetings/${m.id}` })] },
    });
  } else if (withDecisions.length > 1) {
    const n = withDecisions.reduce((a, m) => a + m.decisions.length, 0);
    cand.push({
      weight: 60, section: 'yesterday',
      s: {
        text: `Вчера на ${withDecisions.length} ${plural(withDecisions.length, 'встрече', 'встречах', 'встречах')} приняли ${n} ${plural(n, 'решение', 'решения', 'решений')}; главное — ${withDecisions[0].decisions[0].replace(/[.!]+$/, '')}.`,
        refs: withDecisions.slice(0, 3).map((m) => src({ kind: 'meeting', label: `${m.title} · вчера ${m.at}`, link: `/meetings/${m.id}` })),
      },
    });
  }
  if (f.postcall.length) {
    const p = f.postcall[0];
    const link = `/meetings/${p.meetingId}/postcall`;
    cand.push({
      weight: 55, section: 'yesterday',
      s: {
        text: f.postcall.length === 1 ? `Итоги вчерашней встречи ${q(p.title, 50)} ещё не разобраны.` : `Итоги ${f.postcall.length} вчерашних встреч ещё не разобраны.`,
        refs: [src({ kind: 'postcall', label: `Итоги: ${p.title}`, link })],
      },
      action: { kind: 'postcall', label: 'Разобрать итоги', link },
    });
  }

  // ── сегодня: главное — из тройки, внешнее — честно как внешнее ──
  if (hot.length) {
    const names = hot.slice(0, 2).map((i) => q(i.title));
    const overdue = hot.some((i) => i.deadlineDate! < f.today);
    cand.push({
      weight: 100, section: 'today',
      s: {
        text: `Сегодня главное — ${names.join(' и ')}: ${overdue ? 'срок уже прошёл' : 'срок сегодня'}.`,
        refs: hot.slice(0, 2).map((i) => src({ kind: 'task', label: `${i.title} · ${i.deadlineDate! < f.today ? 'просрочено' : 'срок сегодня'}`, link: taskLink(i.projectId, i.taskId) })),
      },
    });
    hot.slice(0, 2).forEach((i) => i.taskId && mentions.push(`${i.kind}:${i.taskId}`));
  } else if (active.length) {
    const first = active.sort((a, b) => a.rank - b.rank)[0];
    cand.push({
      weight: 90, section: 'today',
      s: { text: `Главное на сегодня — ${q(first.title)}.`, refs: [src({ kind: 'task', label: first.projectName ? `${first.title} · ${first.projectName}` : first.title, link: taskLink(first.projectId, first.taskId) })] },
    });
    if (first.taskId) mentions.push(`${first.kind}:${first.taskId}`);
  }
  if (f.dueOutside.length) {
    const d = f.dueOutside[0];
    const more = f.dueOutside.length - 1;
    cand.push({
      weight: 70, section: 'today',
      s: {
        text: `Ещё ${d.overdue ? 'просрочено' : 'срок сегодня'} у ${q(d.title, 50)}${more > 0 ? ` и ещё ${more}` : ''} — в план не вошло, держите в виду.`,
        refs: [src({ kind: 'task', label: `${d.title} · ${d.overdue ? 'просрочено' : 'срок сегодня'}`, link: taskLink(d.projectId, d.taskId) })],
      },
    });
    mentions.push(`task:${d.taskId}`);
  }

  // ── сдано и ждёт проверки (ТЗ-30): не просрочка, одной строкой ──
  if (f.submittedWaiting) {
    const n = f.submittedWaiting;
    cand.push({
      weight: 35, section: 'today',
      s: { text: `Ещё ${n} ${plural(n, 'выполненная задача ждёт', 'выполненные задачи ждут', 'выполненных задач ждут')} проверки — от вас по ним ничего не нужно.`, refs: [] },
    });
  }

  // ── обещания (п. 44) ──
  if (f.commitments.length) {
    const c = f.commitments[0];
    cand.push({
      weight: 80, section: 'promise',
      s: {
        text: `Вы обещали ${c.action.replace(/[.!]+$/, '')} — это ещё не закрыто${f.commitments.length > 1 ? `; таких обещаний ${f.commitments.length}` : ''}.`,
        refs: [src({ kind: 'commitment', label: c.sourceLabel, link: c.sourceLink })],
      },
    });
    if (c.taskId) mentions.push(`task:${c.taskId}`);
  }

  // ── решения (п. 45): одна строка и кнопка, не ещё один ящик ──
  const waitN = f.waiting.proposals + f.waiting.approvals;
  if (waitN > 0) {
    cand.push({
      weight: f.boss ? 75 : 50, section: 'decide',
      s: { text: `От вас ждут ${waitN} ${plural(waitN, 'решение', 'решения', 'решений')}.`, refs: [src({ kind: 'decisions', label: `Ждут решения: ${waitN}`, link: '/focus/inbox' })] },
      action: { kind: 'decisions', label: 'Разобрать', link: '/focus/inbox' },
    });
  }

  // ── календарь (п. 46) ──
  if (f.firstMeeting) {
    const m = f.firstMeeting;
    const soon = m.minutesLeft <= 60;
    cand.push({
      weight: soon ? 85 : 40, section: 'calendar',
      s: {
        text: soon
          ? `В ${m.time} встреча ${q(m.title, 50)} — через ${m.minutesLeft} ${plural(m.minutesLeft, 'минуту', 'минуты', 'минут')}.`
          : f.meetingsToday > 1
            ? `Встреч сегодня: ${f.meetingsToday}, первая в ${m.time} — ${q(m.title, 50)}.`
            : `Встреча сегодня одна — в ${m.time}, ${q(m.title, 50)}.`,
        refs: [src({ kind: 'calendar', label: `${m.title} · ${m.time}`, link: '/calendar' })],
      },
      action: soon ? { kind: 'meeting', label: 'Открыть встречу', link: '/calendar' } : undefined,
    });
  }

  // ── объявления: только обязательные (п. 48) ──
  if (f.announcements.length) {
    const a = f.announcements[0];
    cand.push({
      weight: 65, section: 'news',
      s: { text: `Есть объявление, которое нужно подтвердить: ${q(a.title, 60)}.`, refs: [src({ kind: 'news', label: a.title, link: `/news/${a.id}` })] },
      action: { kind: 'news', label: 'Прочитать', link: `/news/${a.id}` },
    });
  }

  if (f.clients && f.clients.followups > 0) {
    const n = f.clients.followups;
    cand.push({
      weight: 45, section: 'clients',
      s: { text: `Клиентам готовы ${n} ${plural(n, 'письмо', 'письма', 'писем')} по итогам встреч — ждут вашей отправки.`, refs: [src({ kind: 'clients', label: `Письма клиентам: ${n}`, link: '/focus/inbox' })] },
      action: { kind: 'clients', label: 'Посмотреть письма', link: '/focus/inbox' },
    });
  }

  if (f.team) {
    const o = f.team.overloaded;
    cand.push({
      weight: o.length ? 58 : 20, section: 'team',
      s: {
        text: o.length
          ? `В команде перегружены: ${o.slice(0, 3).join(', ')}${o.length > 3 ? ` и ещё ${o.length - 3}` : ''}.`
          : 'По команде перегрузок нет.',
        refs: [src({ kind: 'team', label: o.length ? `Перегружены: ${o.length}` : 'Загрузка команды в норме', link: '/radar' })],
      },
    });
  }

  const room = length === 'short' ? 2 : 4;
  const picked = [...cand].sort((a, b) => b.weight - a.weight).slice(0, room)
    .sort((a, b) => ORDER.indexOf(a.section) - ORDER.indexOf(b.section));
  const sentences = picked.map((c) => c.s);
  for (const c of picked) if (c.action && !actions.some((a) => a.kind === c.action!.kind)) actions.push(c.action);

  // итог — про тройку: «ниже», «не стал заполнять искусственно» (п. 72–73)
  const n = active.length;
  if (n) {
    sentences.push({ text: n === 1 ? 'Одно главное действие — ниже.' : `${n === 2 ? 'Два главных действия' : 'Три главных действия'} — ниже.`, refs: [] });
  } else if (!f.top.length) {
    if (!sentences.length) sentences.push({ text: 'На сегодня критичных дедлайнов нет.', refs: [] });
    sentences.push({ text: 'Я не стал искусственно заполнять план — задачу можно выбрать самому.', refs: [] });
  } else {
    sentences.push({ text: 'Всё главное на сегодня уже сделано.', refs: [] });
  }

  // в источники — только то, на что ссылается текст
  const used = new Set(sentences.flatMap((s) => s.refs));
  return { sentences, sources: sources.filter((s) => used.has(s.id)), actions, mentions };
}

export const briefText = (b: Pick<ComposedBrief, 'sentences'>) => b.sentences.map((s) => s.text).join(' ');

/** Для голоса: приветствие по имени, без кавычек и тире (синтез читает их паузами и мусором). */
export function speechScript(name: string | null, text: string, hour: number): string {
  const hello = hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
  return `${hello}${name ? `, ${name.split(' ')[0]}` : ''}. ${text}`
    .replace(/[«»"]/g, '')
    .replace(/\s+—\s+/g, ', ')
    .replace(/…/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Подпись кнопки: «30 сек» — только если запись действительно около 30 секунд (п. 9). */
export function listenLabel(sec: number | null): string {
  if (!sec || sec <= 0) return 'Прослушать';
  return `Прослушать · ${Math.round(sec)} сек`;
}

/** Оценка длительности до синтеза: ~14 знаков в секунду русской речи tts-1. */
export const estimateSpeechSec = (script: string) => Math.max(5, Math.round(script.length / 14));

const numbersOf = (s: string) => (s.match(/\d+(?:[:.,]\d+)?/g) ?? []).map((x) => x.replace(',', '.'));
const quotesOf = (s: string) => (s.match(/«[^»]+»/g) ?? []).map((x) => x.slice(1, -1).replace(/…$/, '').trim().toLowerCase());
const sentencesOf = (s: string) => s.split(/(?<=[.!?…])\s+/).filter((x) => x.trim().length > 1);

/**
 * Проверка формулировки модели (п. 21–22): в её тексте не должно быть чисел и
 * названий, которых нет в тексте правил, и он не длиннее 5–6 предложений.
 * Нарушено — показываем текст правил: скучнее, но правда.
 */
export function acceptPolish(rules: string, polished: string): boolean {
  const p = polished.trim();
  if (!p || p.length > rules.length * 1.4 + 120) return false;
  if (sentencesOf(p).length > 6) return false;
  const nums = new Set(numbersOf(rules));
  if (numbersOf(p).some((n) => !nums.has(n))) return false;
  const lower = rules.toLowerCase();
  if (quotesOf(p).some((t) => t && !lower.includes(t))) return false;
  // ни мотивационных восклицаний, ни списков (п. 20)
  if (/!/.test(p) || /^\s*[-•*]/m.test(p)) return false;
  return true;
}

/** Версия фактов: тот же набор — тот же текст и то же аудио (п. 62–63). */
export function factsHash(f: BriefFacts, length: BriefLength): string {
  // минуты до встречи меняются каждую минуту — в версии только сама встреча
  const stable = { ...f, firstMeeting: f.firstMeeting ? { id: f.firstMeeting.id, time: f.firstMeeting.time, soon: f.firstMeeting.minutesLeft <= 60 } : null, length, v: FACTS_VERSION };
  return createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

export const textHash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Пресет по роли (п. 51–52): руководителю — клиенты и команда, сотруднику — своё. */
export function presetFor(boss: boolean, prefs: { teamSignals: boolean | null; clients: boolean | null }) {
  return {
    teamSignals: boss && (prefs.teamSignals ?? true),
    clients: prefs.clients ?? boss,
  };
}

export const FEEDBACK_REASONS = ['not_relevant', 'missed_task', 'too_detailed', 'wrong_priority', 'other'] as const;
export const BRIEF_EVENTS = [
  'viewed', 'audio_played', 'audio_completed', 'source_opened', 'refreshed',
  'take_work', 'deep_work_from_brief', 'team_pulse_opened', 'zen_enabled', 'action_opened',
] as const;
