/**
 * «Входящие» чатов по ТЗ #4902 (пп. 5–6) — чистые правила.
 *
 * «Ждут вашего ответа»: вопрос или просьба к человеку (личка, упоминание), на которую
 * он не ответил дольше 4 часов. Ответил в ветке или в личке — пропадает само.
 * «Мои вопросы без ответа»: что спросил сам, а собеседник молчит больше суток.
 */

export interface Msg { id: string; chatId: string; chatKind: string; chatTitle: string | null; authorId: string; author: string; body: string; at: Date; threadRootId: string | null; mentionsMe: boolean }

// \b не видит кириллицу — границы слова пишем явно
const ASK = /(\?|^(?:подскажи|скажи|посмотри|проверь|сделай|пришли|скинь|можешь|сможешь|нужно|надо|глянь|ответь|дай знать)|(?:^|\s)(?:можешь|сможешь|не мог бы|не могла бы|когда будет|когда сможешь)(?=[\s,.!?]|$)|ставить задачу или нет)/i;

/** Похоже на вопрос или просьбу к человеку. */
export function isAsk(body: string): boolean {
  const t = body.trim();
  return t.length >= 3 && ASK.test(t.replace(/^@\S+[\s,]*/, ''));
}

/**
 * Вопросы ко мне без ответа дольше `hours`: сообщение от другого в личке или с моим
 * упоминанием, похожее на вопрос/просьбу, и после него в том же разговоре (ветке) я не писал.
 */
export function waitingForMe(list: Msg[], meId: string, now: Date, hours = 4): Msg[] {
  const out: Msg[] = [];
  const key = (m: Msg) => `${m.chatId}:${m.threadRootId ?? ''}`;
  const lastMine = new Map<string, number>();
  for (const m of list) if (m.authorId === meId) lastMine.set(key(m), Math.max(lastMine.get(key(m)) ?? 0, m.at.getTime()));
  for (const m of list) {
    if (m.authorId === meId) continue;
    if (!(m.chatKind === 'dm' || m.mentionsMe)) continue;
    if (!isAsk(m.body)) continue;
    if (now.getTime() - m.at.getTime() < hours * 3_600_000) continue;
    // ответил позже в том же разговоре — вопрос закрыт; ответ в ветке на сообщение тоже
    const answered = (lastMine.get(key(m)) ?? 0) > m.at.getTime() || (lastMine.get(`${m.chatId}:${m.id}`) ?? 0) > m.at.getTime();
    if (answered) continue;
    out.push(m);
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Мои вопросы, на которые молчат дольше суток. */
export function myUnanswered(list: Msg[], meId: string, now: Date, hours = 24): Msg[] {
  const key = (m: Msg) => `${m.chatId}:${m.threadRootId ?? ''}`;
  const lastOther = new Map<string, number>();
  for (const m of list) if (m.authorId !== meId) lastOther.set(key(m), Math.max(lastOther.get(key(m)) ?? 0, m.at.getTime()));
  return list.filter((m) => m.authorId === meId && isAsk(m.body) && now.getTime() - m.at.getTime() >= hours * 3_600_000
    && (lastOther.get(key(m)) ?? 0) <= m.at.getTime() && (lastOther.get(`${m.chatId}:${m.id}`) ?? 0) <= m.at.getTime());
}

export const DECISION = /(решили|договорились|итого|утвердили|принято|согласовали|делаем так)/i;

export function ago(at: Date, now: Date): string {
  const h = Math.floor((now.getTime() - at.getTime()) / 3_600_000);
  if (h < 1) return 'меньше часа';
  if (h < 24) return `${h} ч`;
  const d = Math.floor(h / 24);
  return `${d} дн.`;
}
