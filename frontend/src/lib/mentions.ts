/**
 * Упоминания через `@` — разбор без React, чтобы проверялось скриптом (npm run check).
 *
 * В тексте упоминание живёт как обычное «@Имя Фамилия»: читаемо и в письме, и в выгрузке.
 * Кого именно позвали, знает список id рядом с текстом — имена меняются, и разметка
 * после переименования указывала бы в никуда.
 */

export interface MentionUser {
  id: string;
  fullName: string;
  avatarUrl?: string | null;
  /** Кто он в этой задаче: «Исполнитель», «Постановщик». В компании три Сергея. */
  hint?: string;
}

/**
 * Кусок «@…», который человек печатает прямо сейчас, — для подсказки.
 * null означает «подсказку показывать не надо».
 */
export function activeQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  // @ начинает упоминание только на границе слова: адрес почты не в счёт
  if (at > 0 && !/[\s(]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  // имя и фамилия — два слова; дальше человек уже пишет предложение
  if (/\n/.test(query) || query.split(' ').length > 2) return null;
  return { start: at, query };
}

/** Кого показать в подсказке: совпадение по любой части имени, не только по началу. */
export function suggest(users: MentionUser[], query: string, limit = 6): MentionUser[] {
  const needle = query.trim().toLowerCase();
  return users.filter((u) => u.fullName.toLowerCase().includes(needle)).slice(0, limit);
}

/**
 * Разбор текста на куски: строки и упоминания.
 *
 * Ищем по именам сотрудников, а не по «слову после @»: иначе адрес почты и цена
 * «@2000» превращались бы в упоминание несуществующего человека. Длинные имена
 * проверяются первыми — иначе «Иван Петров» совпал бы как «Иван».
 */
export function withMentions(text: string, users: MentionUser[]): (string | { name: string })[] {
  const names = users.map((u) => u.fullName).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return [text];
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`@(${escaped.join('|')})`, 'g');
  const out: (string | { name: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index === undefined) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ name: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Кого действительно позвали: из отмеченных остаются те, чьё имя дожило до отправки.
 * Человек мог стереть вставленное имя — звать его после этого не за что.
 */
export function stillMentioned(ids: string[], text: string, users: MentionUser[]): string[] {
  return ids.filter((id) => {
    const name = users.find((u) => u.id === id)?.fullName;
    return !!name && text.includes(`@${name}`);
  });
}
