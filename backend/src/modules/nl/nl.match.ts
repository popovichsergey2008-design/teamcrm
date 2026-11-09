/**
 * Поиск сотрудника по имени в тексте команды.
 *
 * Модель регулярно не возвращает исполнителя даже когда он назван прямым текстом
 * («поставь на Константина задачу…»), и задача создаётся ничьей. Здесь тот же
 * разбор делается детерминированно: имя в русском тексте почти всегда стоит
 * в косвенном падеже, поэтому сравниваем не слова целиком, а их основы.
 */

const normalize = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Отбрасываем окончание: «Константина» → «константин», «Юрия» и «Юрий» → «юри». */
function stem(word: string): string {
  let w = normalize(word).replace(/[^a-zа-я-]/g, '');
  for (let i = 0; i < 2 && w.length > 3 && /[аяуюеиыойьъ]$/.test(w); i++) {
    w = w.slice(0, -1);
  }
  return w;
}

/*
  #4788: в постановке людей зовут как в жизни — «поставь Косте», «на Серёгу», «Боре», —
  а в базе «Константин», «Сергей» и даже латиницей «Boris Chest». Ни полное имя по
  основе, ни латиница такие фразы не находили, и задача оставалась без исполнителя.
*/

/** Латиница → кириллица на слух: «Boris» → «борис», «Sergey» → «сергей». */
function toCyrillic(word: string): string {
  const w = word.toLowerCase();
  if (!/[a-z]/.test(w)) return w;
  const pairs: Array<[RegExp, string]> = [
    [/shch/g, 'щ'], [/sch/g, 'щ'], [/sh/g, 'ш'], [/ch/g, 'ч'], [/zh/g, 'ж'], [/kh/g, 'х'], [/ts/g, 'ц'],
    [/yu/g, 'ю'], [/ya/g, 'я'], [/yo/g, 'ё'], [/ye/g, 'е'],
    [/([aeiou])y\b/g, '$1й'], [/iy\b/g, 'ий'],
  ];
  let r = w;
  for (const [re, to] of pairs) r = r.replace(re, to);
  const one: Record<string, string> = {
    a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м',
    n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'ы', z: 'з',
  };
  return r.replace(/[a-z]/g, (ch) => one[ch] ?? '');
}

/** Как зовут в жизни: полное имя (основа) → уменьшительные в именительном падеже. */
const NICKNAMES: Record<string, string[]> = {
  константин: ['костя'], сергей: ['серёжа', 'серёга', 'серега'], борис: ['боря'], александр: ['саша', 'шура'],
  александра: ['саша'], алексей: ['лёша', 'лёха'], дмитрий: ['дима'], михаил: ['миша'], николай: ['коля'],
  владимир: ['вова', 'володя'], юрий: ['юра'], андрей: ['андрюша'], павел: ['паша'], иван: ['ваня'],
  евгений: ['женя'], евгения: ['женя'], анастасия: ['настя'], екатерина: ['катя'], мария: ['маша'],
  татьяна: ['таня'], наталья: ['наташа'], наталия: ['наташа'], елена: ['лена'], ольга: ['оля'],
  светлана: ['света'], виктория: ['вика'], анна: ['аня'], григорий: ['гриша'], максим: ['макс'],
  артём: ['тёма'], роман: ['рома'], антон: ['тоша'], илья: ['илюша'], денис: ['дэн'], ксения: ['ксюша'],
  дарья: ['даша'], полина: ['поля'], алина: ['аля'], вячеслав: ['слава'], ярослав: ['слава'], станислав: ['стас'],
  валентин: ['валя'], валентина: ['валя'], людмила: ['люда'], юлия: ['юля'], кирилл: ['киря'], тимофей: ['тима'],
};

/**
 * Основы падежных форм уменьшительного: «Костя» → косте/костю/костей → «кост».
 * Короткая основа («бор» от «Боря») совпала бы с обычным словом «бор» — такие
 * формы сравниваем только целиком: метка «=» перед словом (см. matches).
 */
function nicknameStems(nick: string): string[] {
  const n = normalize(nick);
  if (!/[ая]$/.test(n)) return [stem(n)];
  const base = n.slice(0, -1);
  const soft = n.endsWith('я') || /[жшчщ]$/.test(base);
  const forms = soft
    ? [n, `${base}и`, `${base}е`, `${base}ю`, `${base}ей`, `${base}у`]
    : [n, `${base}ы`, `${base}е`, `${base}у`, `${base}ой`];
  return [...new Set(forms.map((f) => (stem(f).length > 3 ? stem(f) : `=${f}`)))];
}

/**
 * Основы значимых частей имени: «Сергей Попович» → ['серг', 'попович'] + «серёжа», «серёга».
 * Отсекаем по длине ИСХОДНОГО слова, а не основы: иначе «Юрий» отсеивался бы
 * вместе с инициалами, хотя это полноценное имя.
 */
function nameStems(fullName: string): string[] {
  const out = new Set<string>();
  for (const raw of fullName.split(/[\s,]+/)) {
    if (raw.replace(/[^a-zа-яё-]/gi, '').length < 4) continue; // «Про», инициалы и предлоги ловили бы кого попало
    const variants = new Set([normalize(raw), normalize(toCyrillic(raw))]);
    for (const v of variants) {
      out.add(stem(v));
      for (const nick of NICKNAMES[v] ?? NICKNAMES[v.replace(/е/g, 'ё')] ?? []) nicknameStems(nick).forEach((x) => out.add(x));
    }
  }
  return [...out].filter((x) => x.replace('=', '').length >= 3);
}

/** Слова текста: основы и сами слова (для точных коротких форм «=боре»). */
function textWords(text: string): Set<string> {
  const raw = normalize(text).split(/[^a-zа-я-]+/).filter(Boolean);
  return new Set([...raw.map(stem), ...raw.map((w) => `=${w}`)]);
}

export interface NamedUser {
  id: string;
  name: string;
}

/**
 * Единственный сотрудник, чьё имя встречается в тексте.
 *
 * Возвращает null, если совпадений нет или их несколько: угадывать между двумя
 * людьми хуже, чем оставить поле пустым и дать выбрать вручную.
 */
export function matchUserInText(text: string, users: NamedUser[]): string | null {
  const wordSet = textWords(text);
  if (!wordSet.size) return null;

  const hits = users.filter((u) => {
    const stems = nameStems(u.name ?? '');
    return stems.length > 0 && stems.some((s) => wordSet.has(s));
  });
  return hits.length === 1 ? String(hits[0].id) : null;
}

/**
 * Тёзки, названные в тексте (#4798 §15): «Анне» при двух Аннах. Одного по имени не
 * выбираем — человек отвечает, какую из них имел в виду. Пусто — неоднозначности нет.
 */
export function namesakesInText(text: string, users: NamedUser[]): { id: string; name: string }[] {
  const wordSet = textWords(text);
  if (!wordSet.size) return [];
  const byStem = new Map<string, NamedUser[]>();
  for (const u of users) {
    for (const s of nameStems(u.name ?? '')) {
      if (!wordSet.has(s)) continue;
      byStem.set(s, [...(byStem.get(s) ?? []), u]);
    }
  }
  for (const group of byStem.values()) {
    const uniq = [...new Map(group.map((u) => [String(u.id), u])).values()];
    if (uniq.length >= 2) return uniq.map((u) => ({ id: String(u.id), name: u.name ?? '' }));
  }
  return [];
}

/**
 * Срок из разобранной команды.
 *
 * Модель охотно возвращает дату, просто упомянутую в тексте («с дедлайном на вчера»),
 * и задача заводилась уже просроченной. Срок в прошлом сроком не считаем: поставить
 * задачу на вчера нельзя, а нужную дату человек выберет в форме сам.
 * Обе даты в формате YYYY-MM-DD, поэтому сравнение строк совпадает с хронологией.
 */
export function normalizeDeadline(raw: unknown, today: string): string | null {
  const v = String(raw ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  return v >= today ? v : null;
}

/**
 * Все сотрудники, чьи имена прозвучали в тексте (для участников встречи).
 *
 * Основа, общая для двоих («Сергей» при двух Сергеях), не засчитывается никому:
 * позвать не того человека хуже, чем не позвать никого, — названного по фамилии
 * найдём по фамилии.
 */
export function usersNamedInText(text: string, users: NamedUser[]): string[] {
  const words = textWords(text);
  if (!words.size) return [];
  const owners = new Map<string, Set<string>>();
  for (const u of users) {
    for (const s of nameStems(u.name ?? '')) {
      if (!owners.has(s)) owners.set(s, new Set());
      owners.get(s)!.add(String(u.id));
    }
  }
  const out: string[] = [];
  for (const [s, ids] of owners) {
    if (ids.size !== 1 || !words.has(s)) continue;
    const id = [...ids][0];
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/*
  #4808: «Поставить задачу на Глеба… приложение будет делать Сергей» — названы двое,
  и прежнее правило «имя одно» сдавалось: задача уходила руководителю отдела. Кому
  поручают, в речи видно по обороту: «на Глеба», «для Глеба», «поручи Глебу»,
  «назначь Глеба» рядом со словами постановки.
*/
const ASSIGN_VERB = /^(постав|назнач|поруч|повес|кин|закин|отда|дай|дать|задач|задан)/;

/** Кому поручают по обороту речи; ровно один такой человек — его id, иначе null. */
export function addresseeInText(text: string, users: NamedUser[]): string | null {
  const words = normalize(text).split(/[^a-zа-я-]+/).filter(Boolean);
  const hits = new Set<string>();
  for (const u of users) {
    const stems = nameStems(u.name ?? '');
    if (!stems.length) continue;
    words.forEach((w, i) => {
      if (!stems.includes(stem(w)) && !stems.includes(`=${w}`)) return;
      const prev = words[i - 1] ?? '';
      const before = words.slice(Math.max(0, i - 5), i);
      const verbNear = before.some((x) => ASSIGN_VERB.test(x));
      // «на Глеба», «для Глеба» после слов постановки — или «поручи Глебу», «назначь Глеба»
      if (((prev === 'на' || prev === 'для') && verbNear) || ASSIGN_VERB.test(prev)) hits.add(String(u.id));
    });
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * Исполнитель, названный в тексте (#4808): одно имя — оно; несколько — тот, кому
 * поручают оборотом речи, иначе тот из названных, кого выбрала модель. Модель
 * выбрала не из названных — не верим ей, решит общее правило подбора.
 */
export function namedAssignee(text: string, users: NamedUser[], modelId?: string | null): string | null {
  const one = matchUserInText(text, users);
  if (one) return one;
  const mentioned = usersNamedInText(text, users);
  if (mentioned.length < 2) return null;
  const said = addresseeInText(text, users);
  if (said) return said;
  return modelId && mentioned.includes(String(modelId)) ? String(modelId) : null;
}
