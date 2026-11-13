/**
 * Карточки стартового экрана QEVO Bot (#4893, п. 1) — чистые правила.
 *
 * Только числа и имена человека: «3 встречи сегодня — к одной нет повестки», а не
 * «Помогу с календарём». Не больше четырёх; карточка без данных не показывается. Если
 * данных нет совсем (новая команда), — первые шаги: голосом о задаче, команда, календарь.
 */

export interface StartFacts {
  meetings: number; noAgenda: number; firstNoAgenda: string | null;
  decisions: number; needReply: number; reports: number; reportChats: string[];
  project: string | null; members: number;
}
export interface Connections { mail: boolean; calendar: boolean; telegram: boolean }

export type CardAction =
  | { kind: 'prompt'; prompt: string }
  | { kind: 'review' }
  | { kind: 'voice' }
  | { kind: 'link'; href: string }
  | { kind: 'connect'; source: 'calendar' | 'mail' };
export interface StartCard { id: string; text: string; button: string; action: CardAction }

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/** «октябрь» → «октябре», «май» → «мае», «март» → «марте». */
export function inMonth(month: string): string {
  return /[ьй]$/.test(month) ? month.replace(/[ьй]$/, 'е') : `${month}е`;
}

export function buildCards(f: StartFacts, c: Connections): StartCard[] {
  const cards: StartCard[] = [];
  if (f.meetings > 0) {
    const tail = f.noAgenda > 0
      ? (f.meetings === 1 ? ' — без повестки' : ` — к ${f.noAgenda === 1 ? 'одной' : f.noAgenda} нет повестки`)
      : '';
    cards.push({
      id: 'meetings', text: `${f.meetings} ${plural(f.meetings, 'встреча', 'встречи', 'встреч')} сегодня${tail}`, button: 'Подготовить',
      action: { kind: 'prompt', prompt: f.firstNoAgenda
        ? `Подготовь повестку к встрече «${f.firstNoAgenda}» сегодня из открытых задач и прошлых договорённостей, и коротко — к остальным встречам дня.`
        : 'Подготовь меня к сегодняшним встречам: кто будет, что обсуждали раньше, открытые задачи и вопросы.' },
    });
  }
  if (f.decisions > 0) {
    cards.push({ id: 'decisions', text: `${f.decisions} ${plural(f.decisions, 'решение ждёт', 'решения ждут', 'решений ждут')} вас`, button: 'Разобрать за 15 мин', action: { kind: 'review' } });
  }
  if (f.needReply > 0) {
    cards.push({
      id: 'reply', text: `${f.needReply} ${plural(f.needReply, 'сообщение ждёт', 'сообщения ждут', 'сообщений ждут')} ответа`, button: 'Что ответить',
      action: { kind: 'prompt', prompt: 'Какие сообщения ждут моего ответа? Подготовь черновики ответов — ничего не отправляй, покажи каждое карточкой.' },
    });
  }
  if (f.reports > 0) {
    cards.push({
      id: 'reports', text: `${f.reports} ${plural(f.reports, 'отчёт', 'отчёта', 'отчётов')} сотрудников за вчера`, button: 'Свести в один',
      action: { kind: 'prompt', prompt: `Сведи вчерашние отчёты сотрудников${f.reportChats.length ? ` (${f.reportChats.map((x) => `«${x}»`).join(', ')})` : ''} в одну сводку: по человеку — что сделано, статус «по плану» или «риски», кто не прислал.` },
    });
  }
  if (cards.length) return cards.slice(0, 4);
  // данных нет — первые шаги, а не пустой экран
  const first: StartCard[] = [
    { id: 'voice', text: 'Расскажите голосом о своей задаче — сделаю план', button: 'Сказать голосом', action: { kind: 'voice' } },
  ];
  if (f.members <= 1) first.push({ id: 'invite', text: 'Пригласите команду — задачи и встречи станут общими', button: 'Пригласить', action: { kind: 'link', href: '/settings/team' } });
  if (!c.calendar) first.push({ id: 'calendar', text: 'Подключите календарь — встречи появятся в плане дня', button: 'Подключить', action: { kind: 'connect', source: 'calendar' } });
  if (!c.mail) first.push({ id: 'mail', text: 'Подключите почту — разберу входящие и подготовлю ответы', button: 'Подключить', action: { kind: 'connect', source: 'mail' } });
  return first.slice(0, 4);
}

// ── п. 10: матрица Эйзенхауэра ──

export type Quadrant = 'do' | 'plan' | 'delegate' | 'drop';
export interface MatrixTask {
  id: string; title: string; projectName: string | null; deadlineAt: Date | null; priority: string | null;
  updatedAt: Date; blocksOthers: boolean;
}

/**
 * Квадрант задачи — правилами, без модели: срочно = срок до конца завтра или просрочено;
 * важно = высокий приоритет или на задаче стоят другие. Старые без движения (30+ дней,
 * не срочные и не важные) — кандидаты «Закрыть».
 */
export function quadrantOf(t: MatrixTask, now: Date): Quadrant {
  const urgent = !!t.deadlineAt && t.deadlineAt.getTime() <= now.getTime() + 2 * 86_400_000;
  const important = t.priority === 'high' || t.priority === 'urgent' || t.priority === 'critical' || t.blocksOthers;
  if (urgent && important) return 'do';
  if (important) return 'plan';
  if (urgent) return 'delegate';
  return 'drop';
}

export const isStale = (t: MatrixTask, now: Date) => now.getTime() - t.updatedAt.getTime() > 30 * 86_400_000;

// ── п. 11: бот за неделю ──

export interface WeekCounts { summaries: number; meetingTasks: number; meetings: number; mail: number; tasks: number; reminders: number }
/** Методика оценки: сколько минут человек тратил бы сам на одно такое действие. */
export const MINUTES: Record<keyof WeekCounts, { min: number; what: string }> = {
  summaries: { min: 10, what: 'сводка или разбор (собрать данные из задач, чатов и встреч)' },
  meetingTasks: { min: 4, what: 'задача из встречи (переслушать запись, сформулировать, поставить)' },
  meetings: { min: 5, what: 'поставленная встреча (найти время всех участников, разослать)' },
  mail: { min: 3, what: 'разобранное письмо или черновик ответа' },
  tasks: { min: 3, what: 'поставленная задача (название, исполнитель, срок, чек-лист)' },
  reminders: { min: 1, what: 'напоминание' },
};

export function weekMinutes(c: WeekCounts): number {
  return (Object.keys(MINUTES) as (keyof WeekCounts)[]).reduce((n, k) => n + c[k] * MINUTES[k].min, 0);
}

export function weekText(c: WeekCounts): string {
  const m = weekMinutes(c);
  const parts = [
    c.summaries ? `${c.summaries} ${plural(c.summaries, 'сводка', 'сводки', 'сводок')}` : '',
    c.meetingTasks ? `${c.meetingTasks} ${plural(c.meetingTasks, 'задача', 'задачи', 'задач')} из встреч` : '',
    c.meetings ? `${c.meetings} ${plural(c.meetings, 'встреча поставлена', 'встречи поставлены', 'встреч поставлено')}` : '',
    c.mail ? `${c.mail} ${plural(c.mail, 'письмо разобрано', 'письма разобрано', 'писем разобрано')}` : '',
    c.tasks ? `${c.tasks} ${plural(c.tasks, 'задача поставлена', 'задачи поставлены', 'задач поставлено')}` : '',
    c.reminders ? `${c.reminders} ${plural(c.reminders, 'напоминание', 'напоминания', 'напоминаний')}` : '',
  ].filter(Boolean);
  if (!parts.length) return 'За неделю бот ещё ничего за вас не сделал — поручите первое дело.';
  const saved = m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60 ? `${m % 60} мин` : ''}`.trim() : `${m} мин`;
  return `Бот за неделю: ${parts.join(' · ')}. Это примерно ${saved} вашего времени.`;
}
