/**
 * #4902, п. 13: пароли, токены и номера карт — не в протокол, не в сводки, не в поиск.
 *
 * Чистая функция без обращения к модели: ей пользуются на каждом входе в ИИ, в поиск,
 * в push и Telegram, поэтому она должна быть быстрой, предсказуемой и работать без
 * ключа ИИ. Ошибиться в сторону «скрыли лишнее» дешевле, чем показать пароль в сводке
 * на всю компанию, — но и прятать «пароль от вайфая спросить у Глеба» нельзя: люди
 * перестанут понимать собственную переписку.
 *
 * Скрываем только САМО значение, подпись остаётся: «пароль: ••••••» читается и в
 * сводке, и в поиске — видно, что пароль был, но не видно какой.
 */

export type SecretKind = 'password' | 'token' | 'card' | 'cvv' | 'private_key' | 'connection';

export interface SecretSpan {
  start: number;
  end: number;
  kind: SecretKind;
}

/** Чем заменяем секрет в тексте для ИИ, поиска и рассылок. */
export const SECRET_MASK = '••••••';
/** Метка на месте секрета, перенесённого в «Секреты» проекта. */
export const SECRET_MOVED = '🔒 в Секретах проекта';

/*
  Границы слова — через \p{L}, а не \b: в JS \b не видит кириллицу, и «пароль» внутри
  «перепароль» или после буквы ловился бы наугад (те же грабли были в голосовом вводе).
*/
const NB = '(?<![\\p{L}\\p{N}_])';
/** И справа: «пасс» не должен ловиться в «пассажир», «pass» — в «passport». */
const NA = '(?![\\p{L}])';

/** Подписи, после которых идёт пароль: тут подойдёт почти любое значение. */
const PASS_LABEL = `(?:парол[ьяюеи]|пасс?|pass(?:word|wd)?|pwd|код доступа|кодовое слово)${NA}`;
/** Подписи ключей и токенов: значение должно быть похоже на ключ, а не на слово. */
const KEY_LABEL =
  '(?:токен(?: доступа)?|token|api[ _-]?key|api[ _-]?ключ|апи[ _-]?ключ|ключ(?: api| апи| доступа)?|секрет(?:ный ключ)?|secret(?:[ _-]?key)?|' +
  'client[ _-]?secret|access[ _-]?(?:key|token)|refresh[ _-]?token|app[ _-]?password|private[ _-]?key)' + NA;
/** «пароль от dev-сайта:», «token for prod =» — уточнение между подписью и значением. */
const QUALIFIER = '(?:\\s*\\([^)\\n]{1,40}\\)|\\s+(?:от|для|к|на|по|for|to|of)\\s+[^\\n:=]{1,40}?)?';
const SEP = '\\s*(?:[:=]|—|–|-(?=\\s)|это|is)\\s*';
/** Значение: в кавычках (тогда пробелы разрешены) или до пробела. */
const VALUE = '(?:"([^"\\n]{3,80})"|«([^»\\n]{3,80})»|\'([^\'\\n]{3,80})\'|`([^`\\n]{3,120})`|(\\S{3,200}))';

/*
  Слова, которыми люди ОТВЕЧАЮТ про пароль, а не называют его: «пароль: спроси у Глеба»,
  «пароль — тот же», «пароль: скину в личку». Без этого списка любая фраза с двоеточием
  превращалась бы в точки.
*/
const NOT_A_VALUE = new Set([
  'спросить', 'спроси', 'спросите', 'уточню', 'уточнить', 'уточните', 'скину', 'скинул', 'скинули', 'пришлю', 'пришлю,',
  'отправлю', 'отправил', 'выдам', 'дам', 'дадим', 'будет', 'есть', 'нет', 'не', 'тот', 'та', 'такой', 'такой-же', 'прежний',
  'старый', 'новый', 'сменили', 'поменяли', 'поменял', 'сбросил', 'сбросили', 'лежит', 'смотри', 'см', 'ниже', 'выше', 'позже',
  'завтра', 'сегодня', 'потом', 'обычный', 'стандартный', 'стандартная', 'везде', 'одинаковый', 'у', 'в', 'на', 'из', 'от', 'по',
  'в личке', 'личке', 'личку', 'истёк', 'истек', 'протух', 'устарел', 'неверный', 'неправильный', 'должен', 'нужен', 'нужно',
  'забыл', 'забыли', 'отсутствует', 'пустой', 'none', 'null', 'n/a', 'na', 'tbd', 'todo', 'expired', 'required', 'missing',
  'invalid', 'same', 'later', 'reset', 'see', 'ask', 'the', 'is', 'was', 'will', 'from', 'yandex', 'google', 'secret',
  'password', 'пароль', 'токен', 'token', 'ключ', 'key', 'secrets', 'секретах', 'секреты',
]);

/** Хвост, который почти всегда пунктуация фразы, а не часть пароля. */
function trimTail(v: string): string {
  return v.replace(/[.,;)»"'\]]+$/u, '');
}

/** Уже скрытое или служебное: «********», «•••», «xxx», «🔒 в Секретах проекта». */
function alreadyHidden(v: string): boolean {
  return /^[•*xх.\-_]+$/iu.test(v) || v.includes('🔒') || v.startsWith('<') || v.startsWith('{{');
}

function plainWord(v: string): boolean {
  return /^[\p{L}-]+$/u.test(v) && !/\p{Lu}/u.test(v.slice(1)) && !/\p{N}/u.test(v);
}

/** Пароль после явной подписи: годится почти всё, кроме ответных слов и ссылок. */
function passwordValueOk(v: string): boolean {
  if (v.length < 3 || alreadyHidden(v)) return false;
  if (NOT_A_VALUE.has(v.toLowerCase())) return false;
  if (/^https?:\/\//i.test(v)) return false;
  // одно русское слово из словаря ответов отсеяли выше; короткое слово без цифр — тоже не пароль
  if (plainWord(v) && v.length < 5) return false;
  return true;
}

/** Ключ или токен: длинный, с цифрами или смесью регистров — не «истёк» и не «завтра». */
function keyValueOk(v: string): boolean {
  if (v.length < 12 || alreadyHidden(v)) return false;
  if (NOT_A_VALUE.has(v.toLowerCase())) return false;
  if (/^https?:\/\//i.test(v)) return false;
  if (/[\u0400-\u04FF]/u.test(v)) return false;
  return /\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v)) || /[_\-+/=]/.test(v);
}

/** Без двоеточия («пароль Qwerty123») берём только то, что похоже на пароль, а не на слово. */
function looksLikePassword(v: string): boolean {
  if (v.length < 6 || v.length > 64 || alreadyHidden(v)) return false;
  if (/^https?:/i.test(v)) return false;
  // \u0440\u0443\u0441\u0441\u043A\u0438\u0435 \u0431\u0443\u043A\u0432\u044B \u0432 \u043F\u0430\u0440\u043E\u043B\u0435 \u0431\u044B\u0432\u0430\u044E\u0442 (\u00AB\u043A\u043E\u0442\u0451\u043D\u043E\u043A2019\u00BB), \u043D\u043E \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043C\u0435\u0441\u0442\u0435 \u0441 \u0446\u0438\u0444\u0440\u0430\u043C\u0438
  if (/[\u0400-\u04FF]/u.test(v)) return /\d/.test(v) && /\p{L}/u.test(v) && !/^\d/.test(v);
  const digits = /\d/.test(v);
  const mixed = /[a-z]/.test(v) && /[A-Z]/.test(v);
  const special = /[!@#$%^&*_+=?~]/.test(v);
  // одни цифры — это скорее номер задачи или сумма, а не пароль
  if (/^\d+$/.test(v)) return false;
  return (digits && /[A-Za-z]/.test(v)) || mixed || special;
}

/** Номер карты: 13–19 цифр и сходится контрольная сумма (Луна). */
export function luhnOk(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Ключи с узнаваемым префиксом: их видно и без подписи. */
const TOKEN_PATTERNS: RegExp[] = [
  /(?<![\w-])sk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}/g, // OpenAI / Anthropic / прочие «sk-»
  /(?<![\w])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /(?<![\w])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, // GitHub
  /(?<![\w])github_pat_[A-Za-z0-9_]{40,}/g,
  /(?<![\w])glpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /(?<![\w])xox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g, // AWS
  /(?<![\w])AIza[0-9A-Za-z_-]{35}/g, // Google API
  /(?<![\w])ya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth
  /(?<![\w])y0_[A-Za-z0-9_-]{30,}/g, // Яндекс OAuth
  /(?<![\w])xkeysib-[A-Za-z0-9-]{30,}/g, // Brevo
  /(?<![\w])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /(?<![\w.])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /(?<![\d])\d{8,10}:AA[A-Za-z0-9_-]{30,}/g, // токен Telegram-бота
  /(?<![\w])(?:hf|r8)_[A-Za-z0-9]{30,}/g, // Hugging Face, Replicate
];

/**
 * Найти секреты в тексте. Отрезки не пересекаются и идут по порядку.
 *
 * Отрезок — только значение: подпись («пароль:», «логин/пароль») остаётся видна.
 */
export function detectSecrets(text: string | null | undefined): SecretSpan[] {
  const s = String(text ?? '');
  if (s.length < 6) return [];
  const out: SecretSpan[] = [];
  const add = (start: number, end: number, kind: SecretKind) => { if (end > start) out.push({ start, end, kind }); };

  // 1. Закрытый ключ целиком — от BEGIN до END.
  for (const m of s.matchAll(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g)) {
    add(m.index!, m.index! + m[0].length, 'private_key');
  }

  // 2. Строка подключения с паролем: прячем пароль, хост и логин остаются.
  for (const m of s.matchAll(/(?<![\w])[a-z][a-z0-9+.-]{1,20}:\/\/([^\s:@/]{1,80}):([^\s@/]{1,120})@/gi)) {
    const at = m.index! + m[0].length - 1 - m[2].length;
    add(at, at + m[2].length, 'connection');
  }

  // 3. Ключи с узнаваемым префиксом.
  for (const re of TOKEN_PATTERNS) {
    for (const m of s.matchAll(re)) add(m.index!, m.index! + m[0].length, 'token');
  }
  // Authorization: Bearer xxx
  for (const m of s.matchAll(/(?<![\w])bearer\s+([A-Za-z0-9._~+/=-]{16,})/gi)) {
    const at = m.index! + m[0].length - m[1].length;
    add(at, at + m[1].length, 'token');
  }
  // DB_PASSWORD=…, OPENAI_API_KEY=…, TG_TOKEN: … — переменные окружения из .env
  for (const m of s.matchAll(/(?<![\w])[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD)\s*[=:]\s*["']?([^\s"']{4,})/g)) {
    const at = m.index! + m[0].length - m[1].length;
    add(at, at + m[1].length, 'token');
  }

  // 4. Пары «логин / пароль»: прячем вторую половину — пароль.
  const pairRe = new RegExp(
    `${NB}(?:логин\\s*[/и,]\\s*пароль|логин-пароль|login\\s*[/,&]\\s*pass(?:word)?|user\\s*[/,]\\s*pass(?:word)?|доступы?|креды|учётк[аи]|учетк[аи]|` +
    `аккаунт|акк|account|credentials|creds)${NA}${QUALIFIER}\\s*[:=—–-]?\\s*(\\S{2,80}?)` +
    // двоеточие — только вплотную («admin:pass»): «серверу: root@…» — это подпись, а не пара
    `(?:\\s*[/|;]\\s*|:(?!\\s)|,?\\s*(?:пароль|pass(?:word)?)\\s*:?\\s*)(\\S{3,120})`,
    'giu');
  for (const m of s.matchAll(pairRe)) {
    const raw = m[2];
    const v = trimTail(raw);
    if (!passwordValueOk(v) || plainWord(v)) continue;
    const at = m.index! + m[0].length - raw.length;
    add(at, at + v.length, 'password');
  }
  /*
    «admin / P@ssw0rd2026» без подписи: косая черта с пробелами и справа то, что похоже
    на пароль. Пробелы обязательны — иначе «12/2024» и «React/Vue» стали бы точками.
  */
  for (const m of s.matchAll(/(?<=^|\s)[\w.@+-]{2,60}\s+\/\s+(\S{6,64})/gu)) {
    const v = trimTail(m[1]);
    if (!looksLikePassword(v) || !/\d|[!@#$%^&*]/.test(v)) continue;
    const at = m.index! + m[0].length - m[1].length;
    add(at, at + v.length, 'password');
  }
  // «ivan@mail.ru:Qwerty123» — почта и пароль через двоеточие
  for (const m of s.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+:(\S{4,80})/g)) {
    const v = trimTail(m[1]);
    if (!looksLikePassword(v) && !(v.length >= 4 && /\d/.test(v))) continue;
    const at = m.index! + m[0].length - m[1].length;
    add(at, at + v.length, 'password');
  }

  // 5. «Пароль: …», «пароль от dev-сайта — …», «токен = …».
  const labeled = (label: string, ok: (v: string) => boolean, kind: SecretKind) => {
    const re = new RegExp(`${NB}${label}${QUALIFIER}${SEP}${VALUE}`, 'giu');
    for (const m of s.matchAll(re)) {
      const quoted = m[1] ?? m[2] ?? m[3] ?? m[4];
      const raw = quoted ?? m[5];
      const v = quoted ?? trimTail(raw);
      if (!ok(v)) continue;
      const end = m.index! + m[0].length - (quoted ? 1 : raw.length - v.length);
      add(end - v.length, end, kind);
    }
  };
  labeled(PASS_LABEL, passwordValueOk, 'password');
  labeled(KEY_LABEL, keyValueOk, 'token');
  // «пароль поменяли, новый: …» — подпись оторвалась от значения
  labeled(`(?:нов(?:ый|ая)|временн(?:ый|ая)|new|temporary|temp)${NA}`, looksLikePassword, 'password');
  // ПИН — только цифры: «pin: закрепить сверху» паролем не считаем
  for (const m of s.matchAll(new RegExp(`${NB}(?:пин(?:-?код)?|pin(?:[ -]?code)?)${NA}\\s*[:=—–-]?\\s*(\\d{4,8})(?!\\d)`, 'giu'))) {
    const at = m.index! + m[0].length - m[1].length;
    add(at, at + m[1].length, 'password');
  }
  // «пароль Qwerty123» без двоеточия — только если значение и правда похоже на пароль
  for (const m of s.matchAll(new RegExp(`${NB}(?:парол[ьяюеи]|password|pwd|пасс)${NA}\\s+(?:(?:от|для)\\s+[^\\s:]{1,30}\\s+)?(\\S{6,64})`, 'giu'))) {
    const v = trimTail(m[1]);
    if (!looksLikePassword(v)) continue;
    const at = m.index! + m[0].length - m[1].length;
    add(at, at + v.length, 'password');
  }

  // 6. Номера карт: 13–19 цифр группами через пробел или дефис, с проверкой Луна.
  for (const m of s.matchAll(/(?<![\d+#№-])\d{4}(?:[ -]?\d{2,4}){2,4}(?:[ -]?\d{1,3})?(?![\d])/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhnOk(digits)) continue;
    add(m.index!, m.index! + m[0].length, 'card');
  }
  // CVV/CVC рядом с картой или с подписью
  for (const m of s.matchAll(new RegExp(`${NB}(?:cvv2?|cvc2?|cv2|код безопасности|код с обратной стороны|код на обороте)${NA}\\s*[:=-]?\\s*(\\d{3,4})(?!\\d)`, 'giu'))) {
    const at = m.index! + m[0].length - m[1].length;
    add(at, at + m[1].length, 'cvv');
  }

  return merge(out);
}

/** Пересекающиеся находки — в один отрезок: иначе маска разрезала бы текст дважды. */
function merge(spans: SecretSpan[]): SecretSpan[] {
  if (!spans.length) return spans;
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const res: SecretSpan[] = [{ ...sorted[0] }];
  for (const sp of sorted.slice(1)) {
    const last = res[res.length - 1];
    if (sp.start < last.end) {
      if (sp.end > last.end) last.end = sp.end;
    } else {
      res.push({ ...sp });
    }
  }
  return res;
}

/** Заменить найденные отрезки маской. Отрезки берём готовые, если они уже посчитаны. */
export function applyMask(text: string, spans: SecretSpan[], mask = SECRET_MASK): string {
  if (!spans.length) return text;
  let res = '';
  let pos = 0;
  for (const sp of spans) {
    if (sp.start < pos || sp.end > text.length) continue;
    res += text.slice(pos, sp.start) + mask;
    pos = sp.end;
  }
  return res + text.slice(pos);
}

/**
 * Текст без секретов — для ИИ, поиска, сводок, протоколов, push и Telegram.
 *
 * Пустое и короткое возвращаем как есть: функция стоит на горячих путях.
 */
export function maskSecrets(text: string): string;
export function maskSecrets(text: string | null | undefined): string | null | undefined;
export function maskSecrets(text: string | null | undefined): string | null | undefined {
  if (!text || text.length < 6) return text;
  return applyMask(text, detectSecrets(text));
}

/** Есть ли в тексте секрет — для решения «показывать ли сообщение в выдаче поиска». */
export function hasSecrets(text: string | null | undefined): boolean {
  return detectSecrets(text).length > 0;
}

/**
 * Найден ли запрос в тексте ВНЕ секретов.
 *
 * Поиск по чатам ищет буквы в исходном тексте; если совпало только внутри пароля,
 * выдача сама раскрыла бы его («ищу Qwe → вот сообщение с паролем Qwerty123»).
 */
export function matchesOutsideSecrets(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return maskSecrets(text).toLowerCase().includes(q);
}

/**
 * Отпечаток текста (FNV-1a, 32 бита) — тот же расчёт есть в ленте (SecretText.tsx).
 *
 * Отрезки считаются по смещениям; правка сообщения приходит в ленту только новым
 * текстом, и старые смещения закрыли бы точками не то. Лента сверяет отпечаток и при
 * расхождении перезапрашивает отрезки.
 */
export function textFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * Сообщения чата для участников: исходный текст остаётся (это их переписка), рядом —
 * отрезки секретов, чтобы лента показала их точками и раскрывала по клику.
 *
 * Цитата ответа (`reply_body`) — простой текст без раскрытия: её показываем маской.
 * Строки меняем на месте и возвращаем те же — так помощник встаёт в `.then(...)`.
 */
export function withSecretSpans<T extends { body?: string | null; reply_body?: string | null }>(rows: T[]): T[] {
  for (const r of rows) {
    if (!r) continue;
    const spans = detectSecrets(r.body);
    if (spans.length) {
      const x = r as T & { secret_spans?: SecretSpan[]; secret_of?: string };
      x.secret_spans = spans;
      // отпечаток текста: после правки отрезки устаревают, и лента это видит
      x.secret_of = textFingerprint(String(r.body));
    }
    if (r.reply_body) r.reply_body = maskSecrets(r.reply_body);
  }
  return rows;
}

/**
 * Строки с `body` — для ИИ и выгрузок: текст заменяем маской на месте.
 * Удобно ставить в `.then(maskBodies)` прямо за запросом.
 */
export function maskBodies<T extends { body?: string | null }>(rows: T[]): T[] {
  for (const r of rows) if (r?.body) r.body = maskSecrets(r.body);
  return rows;
}
