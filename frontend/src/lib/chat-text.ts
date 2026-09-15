/**
 * Разбор текста сообщения на части: обычный текст, упоминания и ссылки.
 *
 * Зачем отдельно: в переписке по задаче «@Сергей» и адрес макета — самое важное в
 * сообщении, но серой стеной текста они не читаются. А разбор регулярками — ровно то
 * место, которое ошибается молча: съест точку в конце ссылки, отрежет половину имени
 * или не увидит кириллицу. Поэтому правила лежат здесь и проверяются тестами.
 */

export type Piece =
  | { kind: 'text'; value: string }
  | { kind: 'mention'; value: string }
  | { kind: 'link'; value: string };

/**
 * Имя после «@» — до двух слов.
 *
 * Люди пишут «@Сергей Попович», и обрывать подсветку на первом слове неправильно:
 * в компании три Сергея, и фамилия — часть обращения. Третье слово уже не берём,
 * иначе в упоминание уезжает вся фраза.
 *
 * `\w` и `\b` здесь бесполезны: кириллицу они не видят — на этом мы уже обжигались
 * в разборе голосовых команд.
 */
const MENTION = /@[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё-]*(?:\s+[A-ZА-ЯЁ][A-Za-zА-Яа-яЁё-]*)?/;
/**
 * Адрес до первого пробела. Хвостовую пунктуацию отрезаем ниже — она принадлежит фразе.
 *
 * Ловим три вида написания, потому что все три встречаются в переписке:
 * со схемой (`https://…`), с «www.» и голый домен со слешем — «anthill.team/projects/1».
 * Последний обязан содержать слеш: иначе ссылками станут «т.д.», «5.5» и «e.g.».
 */
const LINK = /(?:https?:\/\/|www\.)[^\s<>]+|[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,6}\/[^\s<>]*/;
/**
 * Перед «@» должен быть край строки или не-буква.
 *
 * Иначе упоминанием становится хвост почтового адреса: в «a@b.ru» видно «@b».
 * Взгляд назад (lookbehind) не используем намеренно — старый Safari на нём падает
 * разбором ВСЕГО бандла, а не одной функции. Захватываем предыдущий символ и
 * возвращаем его обратно в текст.
 */
const TOKEN = new RegExp(`(${LINK.source})|(^|[^A-Za-zА-Яа-яЁё0-9])(${MENTION.source})`, 'g');

/** Точка и скобка в конце — это конец предложения, а не часть адреса. */
function trimTail(url: string): { url: string; tail: string } {
  const m = /[).,;:!?»"']+$/.exec(url);
  if (!m) return { url, tail: '' };
  // «(…)» внутри адреса встречаются (википедия) — закрывающую скобку оставляем,
  // если открывающая есть в самом адресе
  const cut = m[0].replace(/^\)+/, (p) => (url.includes('(') ? '' : p));
  return cut ? { url: url.slice(0, url.length - cut.length), tail: cut } : { url, tail: '' };
}

/**
 * Адрес для атрибута href.
 *
 * Ссылка без схемы («anthill.team/x») в href считается ОТНОСИТЕЛЬНОЙ и уводит внутрь
 * приложения — человек нажимает и попадает на пустую страницу CRM вместо сайта.
 */
export function hrefOf(link: string): string {
  return /^https?:\/\//i.test(link) ? link : `https://${link}`;
}

export function splitMessage(text: string): Piece[] {
  const src = String(text ?? '');
  const out: Piece[] = [];
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', value: src.slice(last, at) });
    if (m[1]) {
      const { url, tail } = trimTail(m[0]);
      out.push({ kind: 'link', value: url });
      if (tail) out.push({ kind: 'text', value: tail });
    } else {
      if (m[2]) out.push({ kind: 'text', value: m[2] });
      out.push({ kind: 'mention', value: m[3] });
    }
    last = at + m[0].length;
  }
  if (last < src.length) out.push({ kind: 'text', value: src.slice(last) });
  return out.filter((p) => p.value !== '');
}

/** Подпись дня над сообщениями: «Сегодня» читается быстрее, чем «2 сентября». */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yesterday = new Date(now.getTime() - 86400000);
  if (same(d, now)) return 'Сегодня';
  if (same(d, yesterday)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/**
 * Дата и время у сообщения: «сегодня 20:34», «вчера 09:12», «12 сентября 20:34».
 *
 * Одного времени мало: заказчик — «не ясно, когда было сделано; дата есть, но
 * ниже, и сопоставлять неудобно». Черта дня над группой сообщений остаётся, но
 * у каждой шапки дата теперь своя — чтобы не искать глазами, к какой черте она
 * относится. Год пишем, только если он не нынешний: «12 сентября» без года
 * читается как этот год, и в январе это начнёт врать.
 */
export function stampLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, now)) return `сегодня ${time}`;
  if (same(d, new Date(now.getTime() - 86400000))) return `вчера ${time}`;
  const withYear = d.getFullYear() !== now.getFullYear();
  const day = d.toLocaleDateString('ru-RU', withYear
    ? { day: 'numeric', month: 'long', year: 'numeric' }
    : { day: 'numeric', month: 'long' });
  return `${day} ${time}`;
}

/**
 * Склеивать ли сообщение с предыдущим.
 *
 * Подряд идущие реплики одного человека — это одна мысль, разбитая на строки.
 * Повторять над каждой имя и время значит превращать разговор в протокол.
 * Разрыв больше десяти минут — уже другой заход, шапку возвращаем.
 */
export function sameGroup(
  prev: { author_id?: unknown; is_ai?: boolean; created_at: string } | undefined,
  cur: { author_id?: unknown; is_ai?: boolean; created_at: string },
  gapMinutes = 10,
): boolean {
  if (!prev) return false;
  if (!!prev.is_ai !== !!cur.is_ai) return false;
  if (String(prev.author_id ?? '') !== String(cur.author_id ?? '')) return false;
  const a = new Date(prev.created_at).getTime();
  const b = new Date(cur.created_at).getTime();
  if (new Date(a).toDateString() !== new Date(b).toDateString()) return false;
  return b - a <= gapMinutes * 60_000;
}
