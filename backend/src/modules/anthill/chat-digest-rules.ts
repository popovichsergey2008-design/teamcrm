/**
 * Сводка переписки секретаря (ТЗ-18, §8.3–8.4) — правилами, без модели.
 *
 * Разбираем только непрочитанное в чатах, где человек участвует, и делим на три
 * кучки: «критично» (срочные слова), «ждут вашего ответа» (вопрос в личке или
 * упоминание), «к сведению» (остальное — числом, без пересказа). И обратное:
 * мои вопросы, на которые не ответили N дней.
 *
 * Модель тут не нужна: «срочно» и вопросительный знак видно и так, а пересказ
 * чужой переписки моделью — это и деньги, и риск выдумки.
 */

export interface DigestMessage {
  id: string; chatId: string; chatKind: string; chatTitle: string | null; author: string; body: string;
  createdAt: Date; mentionsMe: boolean;
}

// \b в JS не видит кириллицу — конец слова проверяем просмотром вперёд
const URGENT = /(срочн|горит|asap|критичн|авари|упал[оаи]?(?![а-яё])|не работает|сломал|блокер|прямо сейчас|немедленно)/i;
const QUESTION_START = /^(когда|где|кто|почему|зачем|сколько|как|можешь|можете|сможешь|сможете|подскажи|подскажите|есть ли|ты\s|вы\s)/i;

export function isUrgent(body: string): boolean {
  return URGENT.test(body);
}

/** Вопрос: со знаком вопроса или с вопросительного слова — «когда будет смета» тоже вопрос. */
export function isQuestion(body: string): boolean {
  const t = body.trim();
  return /\?/.test(t) || QUESTION_START.test(t);
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const where = (m: DigestMessage) => (m.chatKind === 'dm' ? 'в личке' : `в «${clip(m.chatTitle ?? 'чат', 40)}»`);

export interface Digest { critical: DigestMessage[]; needReply: DigestMessage[]; fyi: { chats: number; messages: number } }

export function classify(list: DigestMessage[]): Digest {
  const critical: DigestMessage[] = [];
  const needReply: DigestMessage[] = [];
  const rest: DigestMessage[] = [];
  for (const m of list) {
    if (isUrgent(m.body) && (m.chatKind === 'dm' || m.mentionsMe || m.chatKind === 'group')) critical.push(m);
    else if (m.mentionsMe || (m.chatKind === 'dm' && isQuestion(m.body))) needReply.push(m);
    else rest.push(m);
  }
  return { critical, needReply, fyi: { chats: new Set(rest.map((m) => m.chatId)).size, messages: rest.length } };
}

export function digestText(d: Digest): string | null {
  const lines: string[] = [];
  const show = (m: DigestMessage) => `${m.author} ${where(m)}: «${clip(m.body, 90)}»`;
  if (d.critical.length) lines.push(`Критично (${d.critical.length}):\n${d.critical.slice(0, 5).map((m) => `— ${show(m)}`).join('\n')}`);
  if (d.needReply.length) lines.push(`Ждут вашего ответа (${d.needReply.length}):\n${d.needReply.slice(0, 5).map((m) => `— ${show(m)}`).join('\n')}`);
  if (d.fyi.messages) lines.push(`К сведению: ${d.fyi.messages} непрочитанных в ${d.fyi.chats} ${d.fyi.chats === 1 ? 'чате' : 'чатах'} — без вопросов к вам.`);
  return lines.length ? lines.join('\n') : null;
}

export interface Unanswered { chatId: string; chatKind: string; chatTitle: string | null; to: string; body: string; days: number }

export function unansweredText(list: Unanswered[]): string | null {
  if (!list.length) return null;
  return list.slice(0, 6).map((u) => `— ${u.to} (${u.days} дн.${u.chatKind === 'dm' ? '' : `, «${clip(u.chatTitle ?? 'чат', 30)}»`}): «${clip(u.body, 80)}»`).join('\n');
}
