import { actionInfinitiveStrict, declineName, firstName, guessGender, pastVerb, plural } from '../../common/text/ru-grammar';

/**
 * Обещания (ТЗ-21, §13–25) — распознавание правилами, без модели.
 *
 * Ловим явные обещания от первого лица: «я пришлю смету сегодня», «проверю завтра»,
 * «беру», «сделаю до пятницы». Не считаем обещанием вопрос, условие («если успею»),
 * отрицание («не сделаю»), неуверенность («попробую», «постараюсь») и цитату (§16).
 *
 * Внимание: `\b` в JS не видит кириллицу — границы слов здесь через `\p{L}` (грабли
 * из голосовой постановки задач).
 */

const L = '\\p{L}';
const before = `(?<![${L}])`;
const after = `(?![${L}])`;

/** Глаголы обещания: 1-е лицо будущего (совершенный вид) — «сделаю», «пришлю»… */
const VERBS = [
  'сделаю', 'пришлю', 'вышлю', 'отправлю', 'перешлю', 'передам', 'проверю', 'подготовлю', 'уточню', 'выясню', 'узнаю',
  'возьму', 'скину', 'сброшу', 'напишу', 'допишу', 'позвоню', 'посмотрю', 'доделаю', 'переделаю', 'закрою', 'исправлю',
  'поправлю', 'добавлю', 'загружу', 'выложу', 'согласую', 'соберу', 'оформлю', 'обновлю', 'разберусь', 'займусь',
  'подключу', 'настрою', 'починю', 'завершу', 'сдам', 'отвечу', 'покажу', 'сверю', 'посчитаю', 'оплачу', 'договорюсь',
  'созвонюсь', 'организую', 'назначу', 'забронирую', 'закажу', 'распечатаю', 'подпишу', 'опубликую', 'протестирую',
];
const VERB_RE = new RegExp(`${before}(я\\s+)?(?:(?:сегодня|завтра|сейчас|потом|вечером|утром)\\s+)?(${VERBS.join('|')})${after}`, 'iu');
const TAKE_RE = new RegExp(`${before}(беру(?:\\s+на\\s+себя)?|возьму\\s+на\\s+себя|это\\s+на\\s+мне|за\\s+мной)${after}`, 'iu');
/** То, что делает обещание не обещанием. */
const HEDGE_RE = new RegExp(`${before}(если|может|можно|наверное|возможно|попробую|постараюсь|хотел\\s+бы|хотела\\s+бы|не\\s+знаю|вряд\\s+ли)${after}`, 'iu');
const NEG_RE = new RegExp(`${before}не\\s+(?:${VERBS.join('|')}|беру|возьму|смогу|успею)${after}`, 'iu');

export interface Detected {
  action: string;
  deadline: DeadlineHint | null;
  confidence: number;
}

export type DeadlineHint =
  | { kind: 'local'; date: string; time: string; text: string }
  | { kind: 'relative'; minutes: number; text: string };

/** Одно предложение: от начала глагола до конца фразы. */
function sentenceAround(text: string, index: number): string {
  const startCut = Math.max(text.lastIndexOf('.', index), text.lastIndexOf('!', index), text.lastIndexOf('\n', index), text.lastIndexOf(';', index));
  const rest = text.slice(index);
  const endRel = rest.search(/[.!?;\n]/u);
  return text.slice(startCut + 1, endRel === -1 ? text.length : index + endRel + (rest[endRel] === '?' ? 1 : 0)).trim();
}

/**
 * Обещание в сообщении. `local` — местные дата, время и день недели автора: «завтра»
 * и «до пятницы» считаются от его часов, а не от сервера.
 */
export function detectCommitment(raw: string, local: { date: string; hour: number; minute: number; isoDow: number }): Detected | null {
  const text = String(raw ?? '').trim();
  if (text.length < 5 || text.length > 2000) return null;
  // цитата и пересланное — чужие слова (§16)
  const own = text.split('\n').filter((l) => !l.trim().startsWith('>')).join('\n');
  const m = VERB_RE.exec(own) ?? TAKE_RE.exec(own);
  if (!m) return null;
  const sentence = sentenceAround(own, m.index);
  if (sentence.endsWith('?')) return null;
  if (HEDGE_RE.test(sentence) || NEG_RE.test(sentence)) return null;
  const action = sentence
    .replace(/^[\s,–—-]*(ок|окей|хорошо|да|ладно|понял|поняла|принято)[\s,!.–—-]*/iu, '')
    .replace(new RegExp(`^(я\\s+)`, 'iu'), '')
    .trim();
  if (action.length < 4) return null;
  const deadline = parseDeadline(sentence, local);
  let confidence = 0.78;
  if (/^я\s/iu.test(m[0]) || new RegExp(`${before}я${after}`, 'iu').test(sentence)) confidence += 0.06;
  if (deadline) confidence += 0.06;
  if (action.split(/\s+/).length <= 1) confidence -= 0.1; // «Беру.» — без предмета
  return { action: action.slice(0, 160), deadline, confidence: Math.min(0.95, Math.round(confidence * 100) / 100) };
}

const WEEKDAYS: [RegExp, number][] = [
  [/понедельник/iu, 1], [/вторник/iu, 2], [/сред[уы]/iu, 3], [/четверг/iu, 4], [/пятниц[уыеа]/iu, 5], [/суббот[уыа]/iu, 6], [/воскресень[ея]/iu, 7],
];
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[яй]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Срок из фразы. Без срока — null: проверим через N часов (§21). */
export function parseDeadline(s: string, local: { date: string; hour: number; minute: number; isoDow: number }): DeadlineHint | null {
  const t = s.toLowerCase();
  const time = /(?:к|до|в)\s*(\d{1,2})[:.](\d{2})/u.exec(t);
  const hhmm = time ? `${pad(Math.min(23, Number(time[1])))}:${time[2]}` : null;
  const rel = /через\s+(\d+|полчаса|час)\s*(минут|мин|час|часа|часов|день|дня|дней)?/u.exec(t);
  if (rel) {
    const n = rel[1] === 'полчаса' ? 30 : rel[1] === 'час' ? 60 : Number(rel[1]);
    const unit = rel[2] ?? (rel[1] === 'час' || rel[1] === 'полчаса' ? 'мин' : 'час');
    const minutes = /мин/u.test(unit) || rel[1] === 'полчаса' || rel[1] === 'час' ? n : /час/u.test(unit) ? n * 60 : n * 24 * 60;
    return { kind: 'relative', minutes, text: rel[0] };
  }
  if (/послезавтра/u.test(t)) return { kind: 'local', date: addDays(local.date, 2), time: hhmm ?? '18:00', text: 'послезавтра' };
  if (/завтра/u.test(t)) return { kind: 'local', date: addDays(local.date, 1), time: hhmm ?? '18:00', text: 'завтра' };
  if (/сегодня|до вечера|к вечеру|сейчас/u.test(t)) return { kind: 'local', date: local.date, time: hhmm ?? '18:00', text: 'сегодня' };
  if (/на этой неделе|до конца недели/u.test(t)) {
    const toFri = Math.max(0, 5 - local.isoDow);
    return { kind: 'local', date: addDays(local.date, toFri), time: '18:00', text: 'на этой неделе' };
  }
  if (/на следующей неделе/u.test(t)) return { kind: 'local', date: addDays(local.date, 7 - local.isoDow + 5), time: '18:00', text: 'на следующей неделе' };
  for (const [re, dow] of WEEKDAYS) {
    if (re.test(t)) {
      let diff = (dow - local.isoDow + 7) % 7;
      if (diff === 0) diff = 7;
      return { kind: 'local', date: addDays(local.date, diff), time: hhmm ?? '18:00', text: re.exec(t)![0] };
    }
  }
  const dm = /(?:до|к|на)?\s*(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?/u.exec(t);
  if (dm && Number(dm[2]) >= 1 && Number(dm[2]) <= 12) {
    const year = dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : Number(local.date.slice(0, 4));
    let date = `${year}-${pad(Number(dm[2]))}-${pad(Number(dm[1]))}`;
    if (!dm[3] && date < local.date) date = `${year + 1}${date.slice(4)}`;
    return { kind: 'local', date, time: hhmm ?? '18:00', text: dm[0].trim() };
  }
  const dmw = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join('|')})`, 'u').exec(t);
  if (dmw) {
    const mi = MONTHS.findIndex((x) => new RegExp(`^${x}`, 'u').test(dmw[2]));
    const year = Number(local.date.slice(0, 4));
    let date = `${year}-${pad(mi + 1)}-${pad(Number(dmw[1]))}`;
    if (date < local.date) date = `${year + 1}${date.slice(4)}`;
    return { kind: 'local', date, time: hhmm ?? '18:00', text: dmw[0] };
  }
  if (hhmm) {
    const passed = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) <= local.hour * 60 + local.minute;
    return { kind: 'local', date: passed ? addDays(local.date, 1) : local.date, time: hhmm, text: `к ${hhmm}` };
  }
  return null;
}

const DONE_WORDS = [
  'отправил', 'отправила', 'прислал', 'прислала', 'выслал', 'выслала', 'скинул', 'скинула', 'сбросил', 'сбросила',
  'готово', 'готов', 'готова', 'сделал', 'сделала', 'сделано', 'выложил', 'выложила', 'загрузил', 'загрузила',
  'закрыл', 'закрыла', 'исправил', 'исправила', 'поправил', 'поправила', 'проверил', 'проверила', 'уточнил', 'уточнила',
  'согласовал', 'согласовала', 'держи', 'лови', 'вот', 'прикрепил', 'прикрепила', 'отписался', 'отписалась', 'позвонил', 'позвонила',
];
const DONE_RE = new RegExp(`${before}(${DONE_WORDS.join('|')})${after}`, 'iu');
const URL_RE = /https?:\/\/\S+/iu;

/**
 * Похоже ли сообщение автора обещания на «выполнил» (§21): файл, ссылка или «отправил /
 * готово / держи». Чужие сообщения выполнением не считаем. #1525: ответ обещавшего
 * в том же чате прямо на сообщение с обещанием (reply) — тоже «ответ в чате есть».
 */
export function looksFulfilled(msg: { body: string; hasFile: boolean; repliesToPromise?: boolean }): boolean {
  if (msg.hasFile || msg.repliesToPromise) return true;
  const body = String(msg.body ?? '');
  return URL_RE.test(body) || DONE_RE.test(body);
}

/** Отменили: «не надо», «уже не нужно», «отбой» — от любого участника разговора. */
export function looksCancelled(body: string): boolean {
  return new RegExp(`${before}(не\\s+надо|уже\\s+не\\s+нужно|не\\s+нужно|отбой|отменяется|отменяем|неактуально|не\\s+актуально)${after}`, 'iu').test(String(body ?? ''));
}

/** Нормализованное действие — для «то же самое обещание» (дедуп внутри разговора). */
export function normalizeAction(s: string): string {
  return String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').slice(0, 8).join(' ');
}

/** Похожесть действия и названия задачи — доля общих значимых слов (§20 «same normalized action»). */
export function similarity(a: string, b: string): number {
  const words = (s: string) => new Set(normalizeAction(s).split(' ').filter((w) => w.length > 3).map((w) => w.slice(0, 6)));
  const x = words(a); const y = words(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size);
}

// ───────────────────── текст карточки (#1525, документ заказчика) ─────────────────────

export interface CardTextInput {
  /** кому карточка: самому обещавшему или руководителю (поручившему) */
  self: boolean;
  speakerFullName: string;
  sourceType: 'chat' | 'task' | 'meeting';
  chatKind?: string | null;
  /** название задачи — только если получателю её видно */
  taskTitle?: string | null;
  /** «во вторник», «сегодня», «12 октября» — из whenSaid */
  saidWhen: string;
  action: string;
  /** срок прошёл — его слова («завтра», «к 18:00»); иначе null */
  overdueText: string | null;
  hoursPassed: number;
}

/**
 * «Глеб на созвоне во вторник обещал прислать смету. Прошло 24 часа. Создать задачу в
 * проект или напомнить Глебу в 1 клик?» — дословно по документу. Обещавшему — то же о
 * нём самом: «Вы на созвоне во вторник обещали … напомнить себе в 1 клик?».
 */
export function commitmentCardText(p: CardTextInput): { text: string; remindLabel: string } {
  const name = firstName(p.speakerFullName) || p.speakerFullName || 'Коллега';
  const g = guessGender(p.speakerFullName);
  const where = p.sourceType === 'meeting' ? 'на созвоне'
    : p.sourceType === 'task' ? (p.taskTitle ? `в комментарии к задаче «${p.taskTitle}»` : 'в комментарии к задаче')
      : p.chatKind === 'dm' ? 'в личной переписке' : 'в чате';
  const inf = actionInfinitiveStrict(p.action);
  const verb = p.self ? 'обещали' : pastVerb('обещал', g);
  const who = p.self ? 'Вы' : name;
  const first = inf ? `${who} ${where} ${p.saidWhen} ${verb} ${inf}.` : `${who} ${where} ${p.saidWhen} ${verb}: «${String(p.action).trim()}».`;
  const h = Math.max(1, Math.round(p.hoursPassed));
  const waited = p.overdueText
    ? `Срок «${p.overdueText}» прошёл.`
    : `${plural(h, 'Прошёл', 'Прошло', 'Прошло')} ${h} ${plural(h, 'час', 'часа', 'часов')}.`;
  const whom = p.self ? 'себе' : declineName(name, 'dat', g);
  return {
    text: `${first} ${waited} Создать задачу в проект или напомнить ${whom} в 1 клик?`,
    remindLabel: p.self ? 'Напомнить мне завтра' : `Напомнить ${whom}`,
  };
}
