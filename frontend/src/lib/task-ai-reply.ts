/**
 * Ждут ли от меня ответа в обсуждении задачи (#4639): тогда «Предложить ответ»
 * подсвечен — видно сразу, без поиска по ленте.
 *
 * Правило то же, что у сервера при выборе адресата: смотрим только то, что пришло
 * после моего последнего сообщения; ко мне обращаются, если упомянули («@Имя») или
 * ответили на моё, либо в чужом сообщении есть вопрос.
 */
export interface FeedMessage {
  author_id?: string | number | null;
  body?: string | null;
  is_ai?: boolean;
  is_system?: boolean;
  reply_author?: string | null;
}

export function awaitsMyReply(feed: FeedMessage[], meId: string, meName: string | null): boolean {
  const me = String(meId);
  const name = (meName ?? '').trim().toLocaleLowerCase('ru-RU');
  const first = name.split(/\s+/)[0] ?? '';
  for (let i = feed.length - 1; i >= 0; i--) {
    const m = feed[i];
    if (m.is_ai || m.is_system || m.author_id == null) continue;
    if (String(m.author_id) === me) return false; // после моего ответа — ничего нового
    const body = String(m.body ?? '').toLocaleLowerCase('ru-RU');
    if (body.includes('?')) return true;
    if (name && (body.includes(`@${name}`) || (first.length > 1 && body.includes(`@${first}`)))) return true;
    if (name && (m.reply_author ?? '').trim().toLocaleLowerCase('ru-RU') === name) return true;
  }
  return false;
}
