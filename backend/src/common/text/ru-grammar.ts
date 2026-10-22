/**
 * Русская грамматика для фраз секретаря (#1525) — чистые функции, без словарей «на всё».
 *
 * Документ заказчика требует живых фраз: «Глеб на созвоне во вторник обещал прислать
 * смету… напомнить Глебу», «Вчера на созвоне с Сергеем…», «горящий дедлайн у Глеба».
 * Для этого нужно немногое: имя из полного имени, пол (по отчеству, фамилии, окончанию
 * имени), падежи имени, «во вторник» и инфинитив из обещания в 1-м лице («скину» →
 * «прислать»). Где правила не уверены, функции возвращают нейтральный вариант
 * («обещал(а)», имя без изменения), а не угадывают наобум.
 */

export type Gender = 'm' | 'f' | null;

const SURNAME_RE = /(ов|ев|ёв|ин|ын|ский|цкий|ской|ова|ева|ёва|ина|ына|ская|цкая|ко|енко|ук|юк|их|ых)$/iu;
const PATRONYMIC_RE = /(вич|вна|ична|чна|ьич|оглы|кызы)$/iu;
const isCyr = (s: string) => /^[\p{Script=Cyrillic}-]+$/u.test(s);

/** Имя без фамилии и отчества: «Иванов Глеб Петрович» → «Глеб», «Глеб Иванов» → «Глеб». */
export function firstName(full: string | null | undefined): string {
  const w = String(full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '';
  if (w.length >= 3 && PATRONYMIC_RE.test(w[2])) return w[1];
  if (w.length >= 2 && PATRONYMIC_RE.test(w[1])) return w[0];
  if (w.length >= 2 && SURNAME_RE.test(w[0]) && !SURNAME_RE.test(w[1]) && isCyr(w[0])) return w[1];
  return w[0];
}

/** Мужские имена на -а/-я (их окончание обманывает правило «на -а — женское»). */
const MALE_A = new Set([
  'илья', 'никита', 'кузьма', 'фома', 'лука', 'савва', 'данила', 'гаврила', 'фока', 'миша', 'паша', 'дима', 'ваня', 'петя',
  'коля', 'вова', 'сеня', 'гоша', 'лёша', 'леша', 'алёша', 'алеша', 'гриша', 'серёжа', 'сережа', 'володя', 'федя', 'боря',
  'толя', 'витя', 'стёпа', 'степа', 'костя', 'юра', 'жора', 'вася', 'миля', 'тёма', 'тема', 'рома', 'вадя', 'кирюша',
  'яша', 'гена', 'лёва', 'лева', 'фима',
]);
/** Одинаковые для обоих полов — по имени пол не решаем. */
const UNISEX = new Set(['саша', 'женя', 'валя', 'шура', 'сава', 'никола', 'слава']);
const FEMALE_SOFT = new Set(['любовь', 'нинель', 'адель', 'эсфирь', 'юдифь', 'рахиль']);
const MALE_SOFT = new Set(['игорь', 'василь', 'шамиль', 'ярослав']);

/**
 * Пол по полному имени: отчество → фамилия → имя. Не уверены — null, и фраза
 * говорит «обещал(а)».
 */
export function guessGender(full: string | null | undefined): Gender {
  const w = String(full ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!w.length) return null;
  for (const x of w) {
    if (/(вич|ьич|оглы)$/u.test(x)) return 'm';
    if (/(вна|ична|чна|кызы)$/u.test(x)) return 'f';
  }
  const name = firstName(full).toLowerCase();
  for (const x of w) {
    if (x === name) continue;
    if (/(ова|ева|ёва|ина|ына|ская|цкая)$/u.test(x)) return 'f';
    if (/(ов|ев|ёв|ин|ын|ский|цкий)$/u.test(x)) return 'm';
  }
  if (!isCyr(name)) return null;
  if (UNISEX.has(name)) return null;
  if (MALE_A.has(name)) return 'm';
  if (/[ая]$/u.test(name)) return 'f';
  if (/ь$/u.test(name)) return FEMALE_SOFT.has(name) ? 'f' : MALE_SOFT.has(name) ? 'm' : null;
  if (/[бвгджзйклмнпрстфхцчшщ]$/u.test(name)) return 'm';
  return null;
}

/** «обещал» / «обещала» / «обещал(а)» — прошедшее время по полу. */
export function pastVerb(stemMasc: string, g: Gender): string {
  return g === 'm' ? stemMasc : g === 'f' ? `${stemMasc}а` : `${stemMasc}(а)`;
}

type Case = 'gen' | 'dat' | 'ins';

/** Сохранить регистр первой буквы исходного слова. */
const keepCase = (src: string, out: string) => (src[0] === src[0].toUpperCase() ? out.charAt(0).toUpperCase() + out.slice(1) : out);

/**
 * Имя в падеже. Только одно слово — имя (фамилию в фразах секретаря не склоняем).
 * Нерусское или непонятное имя возвращается как есть: «Джону» хуже, чем «Джон».
 */
export function declineName(name: string, c: Case, g: Gender = guessGender(name)): string {
  const n = String(name ?? '').trim();
  if (!n || !isCyr(n) || /\s/.test(n)) return n;
  const low = n.toLowerCase();
  const hush = /[жшчщц]$/u;
  const backLingual = /[гкхжшчщ]$/u;
  let out: string | null = null;
  if (/ия$/u.test(low)) {
    const s = low.slice(0, -2);
    out = c === 'gen' ? `${s}ии` : c === 'dat' ? `${s}ии` : `${s}ией`;
  } else if (/ья$/u.test(low)) {
    const s = low.slice(0, -1);
    out = c === 'gen' ? `${s}и` : c === 'dat' ? `${s}е` : `${s}ей`;
  } else if (/а$/u.test(low)) {
    const s = low.slice(0, -1);
    out = c === 'gen' ? (backLingual.test(s) ? `${s}и` : `${s}ы`) : c === 'dat' ? `${s}е` : hush.test(s) ? `${s}ей` : `${s}ой`;
  } else if (/я$/u.test(low)) {
    const s = low.slice(0, -1);
    out = c === 'gen' ? `${s}и` : c === 'dat' ? `${s}е` : `${s}ей`;
  } else if (/ий$/u.test(low)) {
    const s = low.slice(0, -1);
    out = c === 'gen' ? `${s}я` : c === 'dat' ? `${s}ю` : `${s}ем`;
  } else if (/й$/u.test(low)) {
    const s = low.slice(0, -1);
    out = c === 'gen' ? `${s}я` : c === 'dat' ? `${s}ю` : `${s}ем`;
  } else if (/ь$/u.test(low)) {
    const s = low.slice(0, -1);
    if (g === 'f') out = low === 'любовь' ? (c === 'ins' ? 'любовью' : 'любови') : c === 'ins' ? `${low}ю` : `${s}и`;
    else if (g === 'm') out = c === 'gen' ? `${s}я` : c === 'dat' ? `${s}ю` : `${s}ем`;
  } else if (/[бвгджзклмнпрстфхцчшщ]$/u.test(low)) {
    // женские имена на согласную (Ирэн, Нинон) не склоняются
    if (g === 'f') return n;
    out = c === 'gen' ? `${low}а` : c === 'dat' ? `${low}у` : hush.test(low) ? `${low}ем` : `${low}ом`;
  }
  return out ? keepCase(n, out) : n;
}

const WEEKDAY_ACC = ['в воскресенье', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу'];
const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** День недели с предлогом: 0 — воскресенье … 6 — суббота (как Date.getDay). */
export function weekdayOn(dow: number): string {
  return WEEKDAY_ACC[((dow % 7) + 7) % 7];
}

/**
 * Когда это было, относительно «сегодня» по местной дате: «сегодня», «вчера» не
 * говорим нарочно — в документе «во вторник»; дальше недели — «12 октября».
 */
export function whenSaid(localDate: string, todayLocal: string): string {
  if (localDate === todayLocal) return 'сегодня';
  const d = new Date(`${localDate}T12:00:00Z`);
  const days = Math.round((new Date(`${todayLocal}T12:00:00Z`).getTime() - d.getTime()) / 86400_000);
  if (days > 0 && days < 7) return weekdayOn(d.getUTCDay());
  return `${d.getUTCDate()} ${MONTH_GEN[d.getUTCMonth()]}`;
}

/** Множественное число: 1 час, 2 часа, 5 часов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = Math.abs(n) % 10, m100 = Math.abs(n) % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ─────────────────────── инфинитив из 1-го лица ───────────────────────

/** Неправильные и смысловые замены: «скину смету» — это «прислать смету». */
const IRREGULAR: Record<string, string> = {
  скину: 'прислать', сброшу: 'прислать', пришлю: 'прислать', вышлю: 'выслать', перешлю: 'переслать', пошлю: 'послать',
  отошлю: 'отослать', дошлю: 'дослать', возьму: 'взять', беру: 'взять', приму: 'принять', сниму: 'снять', пойму: 'понять',
  займу: 'занять', найму: 'нанять', подниму: 'поднять', отниму: 'отнять', обниму: 'обнять', приду: 'прийти',
  оплачу: 'оплатить', заплачу: 'заплатить', доплачу: 'доплатить', отвечу: 'ответить', замечу: 'заметить', отмечу: 'отметить',
  спрошу: 'спросить', попрошу: 'попросить', переспрошу: 'переспросить', приглашу: 'пригласить', брошу: 'бросить',
  отпущу: 'отпустить', запущу: 'запустить', пущу: 'пустить', выпущу: 'выпустить', допущу: 'допустить',
  посмотрю: 'посмотреть', просмотрю: 'просмотреть', досмотрю: 'досмотреть', пересмотрю: 'пересмотреть', рассмотрю: 'рассмотреть',
  увижу: 'увидеть', погляжу: 'поглядеть', потерплю: 'потерпеть', успею: 'успеть', сумею: 'суметь',
  загружу: 'загрузить', выгружу: 'выгрузить', разгружу: 'разгрузить', погружу: 'погрузить', перегружу: 'перегрузить',
  схожу: 'сходить', зайду: 'зайти', пойду: 'пойти', сделаю: 'сделать', дам: 'дать', сдам: 'сдать', передам: 'передать',
  отдам: 'отдать', продам: 'продать', раздам: 'раздать', подам: 'подать', выдам: 'выдать', издам: 'издать', съем: 'съесть',
  помогу: 'помочь', испеку: 'испечь', привлеку: 'привлечь', отвлеку: 'отвлечь',
  начну: 'начать', отпрошу: 'отпросить', свяжу: 'связать', обсужу: 'обсудить', отслежу: 'отследить', провожу: 'проводить',
  поищу: 'поискать', обращу: 'обратить', посвящу: 'посвятить', поеду: 'поехать', приеду: 'приехать', заеду: 'заехать',
  подъеду: 'подъехать', съезжу: 'съездить', выясню: 'выяснить',
  настрою: 'настроить', построю: 'построить', устрою: 'устроить', перестрою: 'перестроить', подстрою: 'подстроить', утрою: 'утроить', удвою: 'удвоить',
};

/** Вспомогательные: сами по себе обещанием не являются, за ними идёт инфинитив. */
const AUX = new Set(['буду', 'смогу', 'могу', 'хочу', 'постараюсь', 'попробую', 'успею', 'обязуюсь', 'готов', 'готова']);

/** Приставки, с которыми «беру» превращается в «-обрать»: «разберу» → «разобрать». */
const BER_O = /^(раз|от|под|об)беру$/u;

/** Один глагол 1-го лица ед. ч. → инфинитив. Не похоже на глагол — null. */
export function toInfinitive(word: string): string | null {
  const w = String(word ?? '').toLowerCase().replace(/ё/gu, 'е');
  if (!w || !/^\p{Script=Cyrillic}+$/u.test(w)) return null;
  // возвратные: «разберусь» → «разобраться», «созвонюсь» → «созвониться»
  if (/(сь)$/u.test(w) && w.length > 4) {
    const base = toInfinitive(w.slice(0, -2));
    if (!base) return null;
    return base.endsWith('ти') ? `${base}сь` : `${base}ся`;
  }
  const orig = String(word).toLowerCase();
  if (IRREGULAR[orig]) return IRREGULAR[orig];
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (BER_O.test(w)) return w.replace(/беру$/u, 'обрать');
  if (/беру$/u.test(w)) return w.replace(/беру$/u, 'брать');
  if (/пишу$/u.test(w)) return w.replace(/пишу$/u, 'писать');
  if (/кажу$/u.test(w)) return w.replace(/кажу$/u, 'казать');
  if (/смотрю$/u.test(w)) return w.replace(/смотрю$/u, 'смотреть');
  if (/йду$/u.test(w)) return w.replace(/йду$/u, 'йти');
  if (/еду$/u.test(w) && w.length > 4) return w.replace(/еду$/u, 'ести');
  if (/есу$/u.test(w) && w.length > 4) return w.replace(/есу$/u, 'ести');
  if (/ую$/u.test(w)) return w.replace(/ую$/u, 'овать');
  if (/аю$/u.test(w)) return w.replace(/аю$/u, 'ать');
  if (/яю$/u.test(w)) return w.replace(/яю$/u, 'ять');
  if (/ею$/u.test(w)) return w.replace(/ею$/u, 'еть');
  if (/ою$/u.test(w)) return w.replace(/ою$/u, 'ыть');
  // губные + «л»: «отправлю» → «отправить», «подготовлю» → «подготовить»
  if (/[бвмпф]лю$/u.test(w)) return w.replace(/лю$/u, 'ить');
  if (/ну$/u.test(w) && w.length > 3) return w.replace(/ну$/u, 'нуть');
  if (/чу$/u.test(w) && w.length > 3) return w.replace(/чу$/u, 'чить');
  if (/шу$/u.test(w) && w.length > 3) return w.replace(/шу$/u, 'шить');
  if (/жу$/u.test(w) && w.length > 3) return w.replace(/жу$/u, 'жить');
  if (/щу$/u.test(w) && w.length > 3) return w.replace(/щу$/u, 'стить');
  if (/[бвгдзклмнпрстф]ю$/u.test(w) && w.length > 3) return w.replace(/ю$/u, 'ить');
  return null;
}

/**
 * Обещание в 1-м лице → действие в инфинитиве для фразы «обещал …»:
 * «скину смету к вечеру» → «прислать смету к вечеру», «сегодня уточню у юриста» →
 * «уточнить у юриста сегодня». Глагол ищем в первых трёх словах; не нашли — фраза
 * как есть (лучше «обещал: …» с цитатой, чем выдуманный глагол).
 */
export function actionInfinitive(action: string): string {
  return actionInfinitiveStrict(action) ?? String(action ?? '').trim().replace(/[\s.!,;:–—-]+$/u, '');
}

/** То же, но без глагола в начале — null (вызывающий скажет «обещал: …»). */
export function actionInfinitiveStrict(action: string): string | null {
  const text = String(action ?? '').trim().replace(/[\s.!,;:–—-]+$/u, '');
  const words = text.split(/\s+/);
  const lead: string[] = [];
  for (let i = 0; i < Math.min(3, words.length); i++) {
    const w = words[i].replace(/[,!.]+$/u, '');
    const low = w.toLowerCase();
    if (low === 'я') continue;
    if (/^(сегодня|завтра|сейчас|потом|вечером|утром|днем|днём|обязательно|тогда|ок|окей|хорошо|да)$/u.test(low)) { lead.push(low); continue; }
    if (/^(на|за)$/u.test(low)) break;
    // «смогу прислать», «буду готовить» — вспомогательный глагол пропускаем
    if (AUX.has(low)) continue;
    const inf = /(ть|ти|чь|ться|тись)$/u.test(low) ? low : toInfinitive(w);
    if (!inf) break;
    const rest = words.slice(i + 1).join(' ');
    const when = lead.filter((x) => /^(сегодня|завтра|вечером|утром|днем|днём)$/u.test(x));
    return [inf, rest, ...when].filter(Boolean).join(' ').trim();
  }
  return null;
}
