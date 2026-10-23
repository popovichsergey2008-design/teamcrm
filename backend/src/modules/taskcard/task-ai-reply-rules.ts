/**
 * Правила для «Предложить ответ» в обсуждении задачи (#4639, #4641, #4642).
 *
 * Чистые функции без базы и модели: на какое сообщение отвечаем и как звучит
 * «Спасибо». Вынесены отдельно, чтобы выбор адресата проверялся тестом: ошибка тут
 * дороже ошибки модели — ответ уйдёт не тому человеку.
 */

export type AiReplyKind = 'reply' | 'status' | 'thanks';

export interface ReplyMessage {
  id: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  isAi?: boolean;
  isSystem?: boolean;
  /** Автор сообщения, на которое это сообщение отвечает (ответ на МОЁ — значит, мне). */
  replyToAuthorId?: string | null;
}

export interface ReplyTarget {
  message: ReplyMessage;
  /** Почему выбрано именно оно: обращение ко мне, вопрос или просто последнее чужое. */
  reason: 'addressed' | 'question' | 'last';
}

const lower = (s: string) => s.toLocaleLowerCase('ru-RU');

/** Ко мне ли обращаются: «@Имя Фамилия», «@Имя» или ответ на моё сообщение. */
export function addressedTo(m: ReplyMessage, me: { id: string; name: string | null }): boolean {
  if (m.replyToAuthorId != null && String(m.replyToAuthorId) === String(me.id)) return true;
  const name = (me.name ?? '').trim();
  if (!name) return false;
  const body = lower(m.body);
  const first = name.split(/\s+/)[0];
  return body.includes(`@${lower(name)}`) || (first.length >= 2 && body.includes(`@${lower(first)}`));
}

/** Вопрос — по знаку «?»: «подскажи, получится?» модель тоже не узнает надёжнее. */
export const isQuestion = (body: string) => /\?/.test(body);

/** Чужое живое сообщение: не моё, не ответ ИИ, не служебная строка и не пустое. */
const foreign = (m: ReplyMessage, meId: string) =>
  !m.isAi && !m.isSystem && m.authorId != null && String(m.authorId) !== String(meId) && m.body.trim().length > 0;

/**
 * На что отвечать. Сообщения — по времени, старые первыми.
 *
 * Смотрим только то, что пришло ПОСЛЕ моего последнего сообщения: на сказанное до
 * него я уже ответил. Если после меня никто не писал — берём всю ленту (человек
 * открыл задачу и хочет ответить на давний вопрос). Внутри порядок важности:
 * обращение ко мне → вопрос → последнее чужое сообщение. Каждый раз — самое свежее.
 */
export function pickReplyTarget(messages: ReplyMessage[], me: { id: string; name: string | null }): ReplyTarget | null {
  let lastMine = -1;
  messages.forEach((m, i) => {
    if (!m.isAi && !m.isSystem && m.authorId != null && String(m.authorId) === String(me.id)) lastMine = i;
  });
  const after = messages.slice(lastMine + 1).filter((m) => foreign(m, me.id));
  const pool = after.length ? after : messages.filter((m) => foreign(m, me.id));
  if (!pool.length) return null;
  for (let i = pool.length - 1; i >= 0; i--) if (addressedTo(pool[i], me)) return { message: pool[i], reason: 'addressed' };
  for (let i = pool.length - 1; i >= 0; i--) if (isQuestion(pool[i].body)) return { message: pool[i], reason: 'question' };
  return { message: pool[pool.length - 1], reason: 'last' };
}

/** «@Имя Фамилия» — так же, как вставляет поле упоминаний: человек получит уведомление. */
export const mentionOf = (name: string | null | undefined) => (name?.trim() ? `@${name.trim()}` : '');

const THANKS = [
  'спасибо!',
  'спасибо, принял.',
  'спасибо, посмотрю и вернусь.',
  'благодарю, всё понятно.',
  'спасибо за помощь!',
];

/**
 * «Спасибо» — без модели. Короткая благодарность адресату — не тот текст, ради
 * которого стоит тратить ключ компании и секунду ожидания. `variant` — повторное
 * нажатие даёт другой вариант, по кругу.
 */
export function thanksText(name: string | null | undefined, variant = 0): string {
  const phrase = THANKS[((variant % THANKS.length) + THANKS.length) % THANKS.length];
  const who = mentionOf(name);
  return who ? `${who}, ${phrase}` : phrase[0].toLocaleUpperCase('ru-RU') + phrase.slice(1);
}

/**
 * Чистка ответа модели: без «Ответ:», кавычек вокруг и лишних пустых строк.
 * Если модель забыла упомянуть адресата — дописываем его сами: ради этого кнопка.
 */
export function cleanReply(raw: string, addressee: string | null | undefined, max = 1200): string {
  let t = String(raw ?? '').trim()
    .replace(/^```[a-z]*\s*|\s*```$/gi, '')
    .replace(/^(ответ|черновик|вариант\s*\d*|обновление статуса)\s*[:—-]\s*/i, '')
    .replace(/^["«»“”']+|["«»“”']+$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
    t = (end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim();
  }
  const who = mentionOf(addressee);
  if (t && who && !lower(t).includes(lower(who))) t = `${who}, ${t[0].toLocaleLowerCase('ru-RU')}${t.slice(1)}`;
  return t;
}
