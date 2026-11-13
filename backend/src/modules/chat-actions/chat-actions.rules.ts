import { addresseeInText, matchUserInText, NamedUser, normalizeDeadline } from '../nl/nl.match';
import { splitCommand, stripMarker } from '../nl/split-command';
import { pickDeadline } from '../nl/task-draft';
import { demoTitle } from '../onboarding/ai-demo-rules';

/**
 * Правила «Действий с сообщением» (#4902, пп. 7–8). Чистые функции — проверяются jest рядом.
 *
 * п. 7: все поручения из одного сообщения — кому, что, срок — и похожие задачи («связать,
 * а не дублировать»). Модель, если есть, только уточняет; без неё карточка собирается здесь.
 * п. 8: «кто делает…», «я должен?…», «где файл…» — ответ по задачам, ТЗ и протоколам
 * встреч. У каждой строки ответа — источник; строка без источника не показывается.
 *
 * Кириллица в регулярках JS не знает `\b` и `\w` — границы слов везде вручную.
 */

const norm = (s: string) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');
const NB = '(?:^|[^а-яa-z0-9])';
const NA = '(?=[^а-яa-z0-9]|$)';

/* ─────────────────────────── п. 7: поручения ─────────────────────────── */

export interface AssignmentItem {
  /** Ключ пункта внутри карточки: по нему клиент присылает правки, сервер помнит созданное. */
  key: string;
  title: string;
  assigneeId: string | null;
  /** Как назвали человека, если в команде такого не нашли: «дизайнер». */
  assigneeHint: string | null;
  /** YYYY-MM-DD */
  deadline: string | null;
  /** Кусок сообщения, из которого вырос пункт. */
  quote: string;
  /** Уже создана (или связана) — повтор нажатия её не задвоит. */
  taskId?: string | null;
  /** «Связать, а не дублировать»: вместо новой задачи — связь сообщения с этой. */
  linkTaskId?: string | null;
  /** Человек убрал пункт из карточки. */
  skip?: boolean;
}

export interface AssignmentContext {
  users: NamedUser[];
  now: Date;
  authorId: string | null;
  /** Кого позвали через @ в сообщении. */
  mentionIds?: string[];
  /** Личная переписка: собеседник автора. */
  dmPeerId?: string | null;
}

const OBLIGATION = new RegExp(`${NB}(?:нужно|надо|необходимо|прошу|просьба|поручаю|пусть|должен|должна|должны|требуется|не\\s+забудь(?:те)?|займись|займитесь|возьми|возьмите|на\\s+тебе|на\\s+вас)${NA}`, 'i');
const ASK_CAN = new RegExp(`${NB}(?:можешь|можете|сможешь|сможете|могли\\s+бы|мог\\s+бы|могла\\s+бы)${NA}`, 'i');
/** «Сделаю сам», «я подготовлю» — автор берёт на себя. */
const SELF_DO = new RegExp(`^(?:я\s+|сам\s+|сама\s+)?(?:сделаю|подготовлю|проверю|напишу|займусь|возьму|отправлю|допишу|посмотрю|созвонюсь|позвоню|соберу|обновлю|исправлю|поправлю)${NA}`, 'i');
const INFINITIVE = /^[а-я]{3,}(?:ть|ться|ти|чь)$/;
/** Повелительное наклонение: «сделай», «проверь», «напиши», «подготовьте». */
const IMPERATIVE = /^[а-я]{3,}(?:[аеоуя]й|[аеоуя]йте|ь|ьте|и|ите)$/;
/** Слова с теми же окончаниями, которые поручением не являются. */
const NOT_VERB = new Set([
  'мои', 'твои', 'свои', 'наши', 'ваши', 'эти', 'все', 'свой', 'мой', 'твой', 'другой', 'какой', 'такой', 'любой', 'большой',
  'задачи', 'новости', 'правки', 'ссылки', 'детали', 'итоги', 'встречи', 'звонки', 'деньги', 'люди', 'ключи', 'сроки', 'сегодни',
  'дни', 'пожалуйста', 'спасибо', 'привет', 'кстати', 'вообще', 'опять', 'здесь', 'после', 'шаги', 'мысли', 'идеи', 'макеты',
  'тоже', 'очень', 'почти', 'сейчас', 'потом', 'ладно', 'окей', 'хорошо', 'добрый', 'день', 'утро', 'вечер', 'ночь', 'путь',
  'цель', 'роль', 'модель', 'ссылку', 'файли', 'копии', 'версии', 'страницы', 'части', 'линии', 'функции', 'позиции',
]);
/** Прошедшее время («решили», «сделали») и существительные на «-ость», «-ель», «-ись». */
const NOUN_LIKE = /(?:[аяиыеуо]ли|сть|ль|сь|зь|день|тень|лень)$/;
const FILLER = new Set(['пожалуйста', 'плиз', 'срочно', 'давай', 'давайте', 'ну', 'и', 'а', 'также', 'еще', 'потом', 'затем', 'тогда', 'короче', 'итак', 'так', 'ок', 'окей']);

/** Слова фразы без пунктуации, в нижнем регистре. */
const wordsOf = (s: string) => norm(s).split(/[^a-zа-я0-9@-]+/).filter(Boolean);

/**
 * Обращение в начале куска: «Глеб, …», «@Глеб …», «Сергей — …». Найден сотрудник — его id
 * и текст без обращения; иначе — как было.
 */
export function leadingAddress(part: string, users: NamedUser[]): { userId: string | null; hint: string | null; rest: string } {
  const s = part.trim();
  const at = /^@([^\s,:;.!?]+)[\s,:;—–-]*/u.exec(s);
  if (at) {
    const id = matchUserInText(at[1], users);
    let rest = s.slice(at[0].length).trim();
    // «@Глеб Иванов, сделай…» — фамилия того же человека тоже часть обращения
    const next = /^([А-ЯЁA-Z][а-яёa-z-]+)[\s,:;—–-]*/u.exec(rest);
    const u = id ? users.find((x) => String(x.id) === id) : null;
    if (next && u && norm(u.name).split(/\s+/).includes(norm(next[1]))) rest = rest.slice(next[0].length).trim();
    return { userId: id, hint: id ? null : at[1], rest };
  }
  const named = /^([А-ЯЁA-Z][а-яёa-z-]{1,30}(?:\s+[А-ЯЁA-Z][а-яёa-z-]{1,30})?)\s*[,:—–-]\s*/u.exec(s);
  if (named) {
    const id = matchUserInText(named[1], users);
    if (id) return { userId: id, hint: null, rest: s.slice(named[0].length).trim() };
  }
  return { userId: null, hint: null, rest: s };
}

/** Похоже ли на поручение: «нужно…», «Глеб, проверь…», «сделать к пятнице», «можешь подготовить?». */
export function isAssignment(part: string, users: NamedUser[], now = new Date()): boolean {
  const lead = leadingAddress(part, users);
  const text = lead.rest;
  if (norm(text).replace(/[^а-яa-z]/g, '').length < 4) return false;
  // вопрос — поручение, только если это просьба: «можешь подготовить смету?»
  if (/\?\s*$/.test(text)) return ASK_CAN.test(norm(text)) && wordsOf(text).some((w) => INFINITIVE.test(w));
  if (OBLIGATION.test(norm(text)) || SELF_DO.test(norm(text))) return true;
  const words = wordsOf(text).filter((w) => !w.startsWith('@'));
  const first = words.filter((w) => !FILLER.has(w)).slice(0, 3);
  const addressed = !!lead.userId || !!lead.hint || /@\S/.test(part) || !!addresseeInText(part, users);
  const deadline = !!pickDeadline(part, now);
  const imperative = first.some((w) => w.length >= 4 && IMPERATIVE.test(w) && !NOT_VERB.has(w) && !NOUN_LIKE.test(w) && !userWord(w, users));
  if (imperative && (addressed || deadline || words.length >= 2)) return true;
  const infinitive = first.some((w) => INFINITIVE.test(w));
  if (infinitive && (addressed || deadline)) return true;
  if (ASK_CAN.test(norm(text)) && words.some((w) => INFINITIVE.test(w))) return true;
  return false;
}

/** Слово — чьё-то имя (имя «Алексей» оканчивается на «й», как глагол). */
function userWord(w: string, users: NamedUser[]): boolean {
  return users.some((u) => norm(u.name).split(/\s+/).some((p) => p.length >= 3 && (p === w || (w.length >= 4 && p.startsWith(w.slice(0, -1))))));
}

/** Кусок сообщения на поручения: нумерация и «также» — правилом быстрой команды; иначе строки и предложения. */
export function splitAssignments(text: string): string[] {
  const clean = String(text ?? '').replace(/\r/g, '').trim();
  if (!clean) return [];
  const byCommand = splitCommand(clean);
  const base = byCommand.length > 1 ? byCommand.map(stripMarker) : [clean];
  const out: string[] = [];
  for (const b of base) {
    for (const line of b.split(/\n+/)) {
      // предложения: точка/!/?/; и пробел; «т.е.», «т. д.» и числа «1.5» не режем
      const parts = line.split(/(?<=[.!?;])\s+(?=[А-ЯЁA-Z@«"])/u);
      for (const p of parts) {
        const t = p.replace(/^[\s•*·—–-]+/, '').trim();
        if (t.length >= 3) out.push(t);
      }
    }
  }
  return out.slice(0, 12);
}

/** Заголовок поручения: без обращения, вводных слов, «пожалуйста» и срока. */
export function assignmentTitle(part: string, users: NamedUser[]): string {
  const rest = leadingAddress(part, users).rest
    .replace(/^@\S+\s*/u, '')
    .replace(new RegExp(`${NB}(?:пожалуйста|плиз)${NA}[,]?`, 'giu'), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const t = demoTitle(rest) || rest;
  const cut = t.replace(/[\s,;:—–-]+$/u, '').trim().slice(0, 255);
  return cut ? cut.charAt(0).toUpperCase() + cut.slice(1) : '';
}

/**
 * Все поручения сообщения правилами. Шапка без действия («Глеб, к пятнице:») не пункт,
 * но её исполнитель и срок достаются пунктам, у которых своих нет.
 */
export function extractAssignments(text: string, ctx: AssignmentContext): AssignmentItem[] {
  const parts = splitAssignments(text);
  const items: AssignmentItem[] = [];
  let headAssignee: string | null = null;
  let headDeadline: string | null = null;
  for (const part of parts) {
    const lead = leadingAddress(part, ctx.users);
    if (!isAssignment(part, ctx.users, ctx.now)) {
      if (!items.length) {
        headAssignee = lead.userId ?? addresseeInText(part, ctx.users) ?? matchUserInText(part, ctx.users) ?? headAssignee;
        headDeadline = pickDeadline(part, ctx.now) ?? headDeadline;
      }
      continue;
    }
    const title = assignmentTitle(part, ctx.users);
    if (title.length < 3) continue;
    const selfDo = SELF_DO.test(norm(lead.rest));
    const named = lead.userId ?? addresseeInText(part, ctx.users) ?? matchUserInText(lead.rest, ctx.users);
    items.push({
      key: String(items.length + 1),
      title,
      assigneeId: named ?? (selfDo ? ctx.authorId : null),
      assigneeHint: lead.hint,
      deadline: pickDeadline(part, ctx.now),
      quote: part.slice(0, 300),
    });
  }
  // общее на всё сообщение: одно упоминание, адресат личной переписки, шапка
  const oneMention = (ctx.mentionIds ?? []).length === 1 ? String(ctx.mentionIds![0]) : null;
  const fallback = headAssignee ?? oneMention ?? (ctx.dmPeerId ? String(ctx.dmPeerId) : null);
  for (const it of items) {
    if (!it.assigneeId && !it.assigneeHint && fallback) it.assigneeId = fallback;
    if (!it.deadline && headDeadline) it.deadline = headDeadline;
  }
  return items.slice(0, 10);
}

/** Чего не хватает пункту — подсвечивается в карточке. */
export function missingOf(it: Pick<AssignmentItem, 'assigneeId' | 'deadline'>): ('assignee' | 'deadline')[] {
  const out: ('assignee' | 'deadline')[] = [];
  if (!it.assigneeId) out.push('assignee');
  if (!it.deadline) out.push('deadline');
  return out;
}

/**
 * Ответ модели → пункты. Исполнителя модели не верим на слово: только сотрудник, чьё имя
 * она назвала и который есть в команде; срок — только будущая дата, иначе правилом по цитате.
 */
export function itemsFromModel(raw: unknown, ctx: AssignmentContext): AssignmentItem[] | null {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.tasks) ? (raw as any).tasks : null;
  if (!list) return null;
  const today = ctx.now.toISOString().slice(0, 10);
  const out: AssignmentItem[] = [];
  for (const x of list.slice(0, 10)) {
    const title = String(x?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 255);
    if (title.length < 3) continue;
    const quote = String(x?.quote ?? title).slice(0, 300);
    const who = String(x?.assignee ?? '').trim();
    const id = who ? matchUserInText(who, ctx.users) : null;
    out.push({
      key: String(out.length + 1),
      title: title.charAt(0).toUpperCase() + title.slice(1),
      assigneeId: id,
      assigneeHint: who && !id ? who.slice(0, 60) : null,
      deadline: normalizeDeadline(x?.deadline, today) ?? pickDeadline(quote, ctx.now),
      quote,
    });
  }
  return out;
}

/** Подтянуть к пунктам модели то, что правила нашли надёжнее (обращение, @, личка). */
export function mergeWithRules(model: AssignmentItem[], rules: AssignmentItem[], ctx: AssignmentContext): AssignmentItem[] {
  const oneMention = (ctx.mentionIds ?? []).length === 1 ? String(ctx.mentionIds![0]) : null;
  return model.map((m, i) => {
    const twin = rules.find((r) => similarity(r.title, m.title) >= 0.5) ?? (model.length === rules.length ? rules[i] : undefined);
    return {
      ...m,
      assigneeId: m.assigneeId ?? twin?.assigneeId ?? (model.length === 1 ? oneMention ?? ctx.dmPeerId ?? null : null),
      deadline: m.deadline ?? twin?.deadline ?? null,
    };
  });
}

/* ─────────────────── похожие задачи («связать, а не дублировать») ─────────────────── */

const TITLE_STOP = new Set([
  'сделать', 'сделай', 'нужно', 'надо', 'задача', 'задачу', 'пожалуйста', 'проверить', 'добавить', 'посмотреть', 'чтобы',
  'который', 'которые', 'после', 'перед', 'через', 'новый', 'новая', 'новое', 'этот', 'этого', 'нашего', 'наш', 'наша',
]);

/** Основы значимых слов названия: «Обновить логотип на сайте» → ['обнов', 'логот', 'сайт']. */
export function titleStems(title: string): string[] {
  const out = new Set<string>();
  for (const w of norm(title).split(/[^a-zа-я0-9]+/)) {
    if (w.length < 4 || TITLE_STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w.length > 6 ? w.slice(0, 5) : w.slice(0, Math.max(4, w.length - 1)));
  }
  return [...out].slice(0, 8);
}

/** Сходство названий по основам (коэффициент Дайса), 0…1. */
export function similarity(a: string, b: string): number {
  const x = new Set(titleStems(a));
  const y = new Set(titleStems(b));
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const s of x) if (y.has(s)) both++;
  return (2 * both) / (x.size + y.size);
}

export const SIMILAR_SHOW = 0.5;
/** Почти то же название у открытой задачи — по умолчанию «связать» вместо «создать». */
export const SIMILAR_LINK = 0.8;

export interface SimilarTask { id: string; title: string; projectId: string; status: string | null; closed: boolean; score: number }

/** Лучшие похожие для пункта: не больше двух, сначала открытые. */
export function pickSimilar(title: string, candidates: { id: string; title: string; projectId: string; status: string | null; closed: boolean }[]): SimilarTask[] {
  return candidates
    .map((c) => ({ ...c, score: Math.round(similarity(title, c.title) * 100) / 100 }))
    .filter((c) => c.score >= SIMILAR_SHOW)
    .sort((p, q) => (Number(p.closed) - Number(q.closed)) || (q.score - p.score))
    .slice(0, 2);
}

/** Подпись кнопки: «Создать 3», «Создать 2 и связать 1», «Связать 1». */
export function createLabel(items: Pick<AssignmentItem, 'skip' | 'taskId' | 'linkTaskId'>[]): string {
  const left = items.filter((i) => !i.skip && !i.taskId);
  const link = left.filter((i) => i.linkTaskId).length;
  const create = left.length - link;
  if (!create && !link) return 'Всё создано';
  if (!link) return `Создать ${create}`;
  if (!create) return `Связать ${link}`;
  return `Создать ${create} и связать ${link}`;
}

/* ─────────────────────── п. 8: «кто за это отвечает?» ─────────────────────── */

export type QuestionKind = 'me' | 'who' | 'where' | 'when' | 'general';

const Q_ME = new RegExp(`${NB}(?:(?:я|мне)\\s+(?:что\\s+)?(?:должен|должна|должны|надо|нужно|делаю|делать|отвечаю)|(?:должен|должна)\\s+(?:ли\\s+)?я|это\\s+на\\s+мне|на\\s+мне${NA}|мое\\s+(?:дело|задача)|моя\\s+задача)`, 'i');
const Q_WHO = new RegExp(`${NB}(?:кто\\s+(?:у\\s+нас\\s+)?(?:делает|сделает|отвечает|занимается|ведет|должен|будет|взял|возьмет|делал)|чья\\s+(?:это\\s+)?задача|на\\s+ком|кто\\s+ответственн|кто\\s+за\\s+(?:это|него|нее|них))`, 'i');
const Q_WHERE = new RegExp(`${NB}(?:где|куда|откуда)\\s+(?:[а-яa-z]+\\s+){0,3}(?:лежит|лежат|файл|документ|ссылк|макет|тз|найти|взять|скачать|посмотреть|выложил|выложили|сохранил|находится)`, 'i');
const Q_WHERE_FILE = new RegExp(`${NB}где${NA}.*(?:файл|документ|ссылк|макет|тз|презентац|договор)`, 'i');
const Q_WHEN = new RegExp(`${NB}когда\\s+(?:[а-яa-z]+\\s+){0,3}(?:будет|готов|сдаем|сдать|срок|дедлайн|закончим|запуск)|какой\\s+срок|до\\s+какого`, 'i');

export function questionKind(text: string): QuestionKind {
  const t = norm(text);
  if (Q_ME.test(t)) return 'me';
  if (Q_WHO.test(t)) return 'who';
  if (Q_WHERE.test(t) || Q_WHERE_FILE.test(t)) return 'where';
  if (Q_WHEN.test(t)) return 'when';
  return 'general';
}

/** Сообщение — вопрос об ответственности/контексте: под ним стоит подсказать «Спросить про контекст». */
export function isContextQuestion(text: string): boolean {
  return questionKind(text) !== 'general';
}

const ASK_STOP = new Set([
  'кто', 'что', 'где', 'куда', 'когда', 'делает', 'сделает', 'отвечает', 'занимается', 'должен', 'должна', 'должны', 'надо',
  'нужно', 'лежит', 'лежат', 'найти', 'взять', 'вообще', 'кстати', 'этот', 'этим', 'этой', 'такой', 'будет', 'есть', 'меня',
  'мне', 'тебя', 'тебе', 'курсе', 'материале', 'решил', 'решила', 'точно', 'знать', 'знаешь', 'знает', 'было', 'была', 'были',
  'создавать', 'делать', 'сделать', 'чего', 'чтото', 'что-то', 'ведет', 'должен', 'будем', 'тоже', 'просто', 'сейчас', 'потом',
  'файл', 'файлы', 'документ', 'ссылка', 'ссылку', 'задача', 'задачу', 'задачи', 'можно', 'нужен', 'нужна', 'какой', 'какая',
  'почему', 'зачем', 'здесь', 'там', 'кого', 'кому', 'него', 'нее', 'него', 'ответственный', 'сдаем', 'срок', 'готов', 'готово',
]);

/** Основы предметных слов вопроса: «Видео я должен был создавать?» → ['виде']. Аббревиатуры (ТЗ, API) — целиком. */
export function askStems(text: string): string[] {
  const out = new Set<string>();
  for (const raw of String(text ?? '').split(/[^A-Za-zА-Яа-яЁё0-9-]+/)) {
    const w = norm(raw);
    if (!w) continue;
    if (/^[A-ZА-ЯЁ]{2,5}$/.test(raw) && !ASK_STOP.has(w)) { out.add(w); continue; }
    if (w.length < 4 || ASK_STOP.has(w)) continue;
    out.add(w.length > 6 ? w.slice(0, 5) : w.slice(0, Math.max(3, w.length - 1)));
  }
  return [...out].slice(0, 8);
}

export type SourceKind = 'task' | 'meeting' | 'file' | 'message';
export interface Source { kind: SourceKind; id: string; title: string; projectId?: string | null; taskId?: string | null; chatId?: string | null; messageId?: string | null }
export interface AnswerLine { text: string; sources: Source[] }

export interface TaskFact {
  id: string; title: string; projectId: string; projectName: string | null;
  assigneeId: string | null; assignee: string | null; authorId: string | null; author: string | null;
  status: string | null; deadline: string | null; closed: boolean;
  files: string[]; links: string[]; score: number;
}
export interface MeetingFact {
  id: string; title: string; at: string | null; what: 'decision' | 'draft' | 'summary'; text: string;
  assigneeId: string | null; assignee: string | null; taskId: string | null;
}
export interface FileFact { id: string; name: string; taskId: string | null; taskTitle: string | null; projectId: string | null; chatId: string | null; messageId: string | null; chat: string | null }
export interface Facts { tasks: TaskFact[]; meetings: MeetingFact[]; files: FileFact[] }

const dd = (iso: string | null) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '');
const taskSrc = (t: TaskFact): Source => ({ kind: 'task', id: t.id, title: t.title, projectId: t.projectId });
const meetSrc = (m: MeetingFact): Source => ({ kind: 'meeting', id: m.id, title: m.title });
const fileSrc = (f: FileFact): Source => ({ kind: 'file', id: f.id, title: f.name, taskId: f.taskId, projectId: f.projectId, chatId: f.chatId, messageId: f.messageId });

function taskLine(t: TaskFact, kind: QuestionKind, viewerId: string): AnswerLine {
  const ref = `задача #${t.id} «${t.title}»`;
  const deadline = t.deadline ? `, срок ${dd(t.deadline)}` : '';
  const state = t.closed ? ' (уже закрыта)' : t.status ? ` (${t.status})` : '';
  let text: string;
  if (kind === 'me') {
    if (t.assigneeId && t.assigneeId === viewerId) text = `Да, это на вас: ${ref}${deadline}${state}.`;
    else if (t.assigneeId) text = `По ${ref.replace('задача', 'задаче')} исполнитель — ${t.assignee}, не вы${state}.`;
    else text = `У ${ref.replace('задача', 'задачи')} исполнитель не назначен${t.author ? ` — решает постановщик ${t.author}` : ''}.`;
  } else if (kind === 'when') {
    text = t.deadline ? `Срок по ${ref.replace('задача', 'задаче')} — ${dd(t.deadline)}${t.assignee ? `, делает ${t.assignee}` : ''}${state}.`
      : `У ${ref.replace('задача', 'задачи')} срок не указан${t.assignee ? `, делает ${t.assignee}` : ''}${state}.`;
  } else {
    text = t.assignee ? `${cap(ref)} — делает ${t.assignee}${deadline}${state}.`
      : `${cap(ref)} — исполнитель не назначен${t.author ? `, поставил ${t.author}` : ''}${state}.`;
  }
  return { text, sources: [taskSrc(t)] };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function meetingLine(m: MeetingFact, viewerId = ''): AnswerLine {
  const when = m.at ? ` ${dd(m.at)}` : '';
  const who = m.assigneeId && m.assigneeId === viewerId ? ' — поручено вам' : m.assignee ? ` — ответственный ${m.assignee}` : ' — ответственный не назван';
  const text = m.what === 'draft'
    ? `На встрече «${m.title}»${when}: «${m.text}»${who}${m.taskId ? ` (задача #${m.taskId})` : ''}.`
    : m.what === 'decision'
      ? `На встрече «${m.title}»${when} решили: ${m.text}.`
      : `В протоколе встречи «${m.title}»${when}: ${m.text}`;
  return { text: text.replace(/\.\.$/, '.'), sources: [meetSrc(m)] };
}

function fileLine(f: FileFact): AnswerLine {
  const where = f.taskId ? `во вложениях задачи #${f.taskId}${f.taskTitle ? ` «${f.taskTitle}»` : ''}` : f.chat ? `в чате «${f.chat}»` : 'в переписке';
  return { text: `Файл «${f.name}» — ${where}.`, sources: [fileSrc(f)] };
}

/** Ответ правилами: строка — один факт и его источник. Без фактов — пусто (сообщит вызывающий). */
export function composeAnswer(kind: QuestionKind, facts: Facts, viewerId: string): AnswerLine[] {
  const lines: AnswerLine[] = [];
  if (kind === 'where') {
    for (const f of facts.files.slice(0, 4)) lines.push(fileLine(f));
    for (const t of facts.tasks.slice(0, 3)) {
      for (const url of t.links.slice(0, 2)) lines.push({ text: `Ссылка в ТЗ задачи #${t.id} «${t.title}»: ${url}`, sources: [taskSrc(t)] });
    }
    if (!lines.length) for (const t of facts.tasks.slice(0, 2)) lines.push(taskLine(t, 'who', viewerId));
  } else {
    for (const t of facts.tasks.slice(0, 3)) lines.push(taskLine(t, kind, viewerId));
  }
  for (const m of facts.meetings.filter((x) => x.what !== 'summary').slice(0, 2)) lines.push(meetingLine(m, viewerId));
  if (!lines.length) for (const m of facts.meetings.slice(0, 1)) lines.push(meetingLine(m, viewerId));
  return lines.slice(0, 6);
}

/** Строки модели: остаются только те, у которых есть хотя бы один НАСТОЯЩИЙ источник из фактов. */
export function sourcedModelLines(raw: unknown, facts: Facts): AnswerLine[] {
  const list = Array.isArray((raw as any)?.lines) ? (raw as any).lines : Array.isArray(raw) ? raw : [];
  const index = new Map<string, Source>();
  for (const t of facts.tasks) index.set(`t${t.id}`, taskSrc(t));
  for (const m of facts.meetings) index.set(`m${m.id}`, meetSrc(m));
  for (const f of facts.files) index.set(`f${f.id}`, fileSrc(f));
  const out: AnswerLine[] = [];
  for (const x of list.slice(0, 8)) {
    const text = String(x?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const ids: unknown[] = Array.isArray(x?.sources) ? x.sources : [];
    const sources = [...new Map(ids.map((s) => index.get(String(s).trim().toLowerCase()))
      .filter((s): s is Source => !!s).map((s) => [`${s.kind}:${s.id}`, s])).values()];
    if (text && sources.length) out.push({ text, sources });
  }
  return out;
}

export interface Ping { userId: string; name: string; taskId: string | null; title: string | null }

/** «Напомнить [кому]»: исполнители открытых найденных задач (не сам спросивший), до трёх. */
export function remindTargets(facts: Facts, viewerId: string): Ping[] {
  const out = new Map<string, Ping>();
  for (const t of facts.tasks) {
    if (t.closed || !t.assigneeId || t.assigneeId === viewerId || out.has(t.assigneeId)) continue;
    out.set(t.assigneeId, { userId: t.assigneeId, name: t.assignee ?? 'исполнитель', taskId: t.id, title: t.title });
  }
  for (const m of facts.meetings) {
    if (!m.assigneeId || m.assigneeId === viewerId || out.has(m.assigneeId)) continue;
    out.set(m.assigneeId, { userId: m.assigneeId, name: m.assignee ?? 'исполнитель', taskId: m.taskId, title: m.text.slice(0, 120) });
  }
  return [...out.values()].slice(0, 3);
}

/**
 * Кого спросить, когда ответа нет: постановщик найденной задачи без исполнителя, иначе
 * постановщик первой найденной, иначе автор сообщения (если это не сам спросивший).
 */
export function askWhom(facts: Facts, viewerId: string, messageAuthor: { id: string; name: string } | null): Ping | null {
  const t = facts.tasks.find((x) => !x.assigneeId && x.authorId && x.authorId !== viewerId)
    ?? facts.tasks.find((x) => x.authorId && x.authorId !== viewerId);
  if (t?.authorId) return { userId: t.authorId, name: t.author ?? 'постановщик', taskId: t.id, title: t.title };
  if (messageAuthor && messageAuthor.id !== viewerId) return { userId: messageAuthor.id, name: messageAuthor.name, taskId: null, title: null };
  return null;
}

/** Текст «Ответить этим в чат»: строки ответа, у каждой — ссылка на источник. */
export function replyText(lines: AnswerLine[]): string {
  return lines.map((l) => {
    const refs = l.sources.map((s) => (s.kind === 'task' ? `#${s.id}` : s.kind === 'meeting' ? `встреча «${s.title}»` : `файл «${s.title}»`));
    const missing = refs.filter((r) => !l.text.includes(r));
    return missing.length ? `${l.text} (источник: ${missing.join(', ')})` : l.text;
  }).join('\n').slice(0, 3800);
}

/** Ссылки из описания задачи (ТЗ): «где макет» часто отвечается именно ими. */
export function linksIn(text: string | null | undefined): string[] {
  return [...new Set(String(text ?? '').match(/https?:\/\/[^\s<>"')\]]+/g) ?? [])].slice(0, 5);
}
