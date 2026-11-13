import { ImportMessage, ImportPerson } from './import-types';

/**
 * Чистые правила переноса (#4902, п. 4) — без базы, чтобы проверять тестами.
 */

export interface TeamUser { id: string; email: string | null; full_name: string | null }

const words = (s: string) => s.toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter(Boolean).sort().join(' ');

/**
 * Кто есть кто: человек старой системы → сотрудник.
 *
 * Сначала почта — она однозначна. Без почты (Telegram её не отдаёт) — по имени, но
 * только если такое имя в команде одно: два «Сергея Иванова» — и мы бы приписали
 * чужие слова не тому человеку. Это хуже, чем подпись именем без привязки.
 * Боты не сопоставляются никогда.
 */
export function matchPeople(people: ImportPerson[], users: TeamUser[]): Map<string, string> {
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const u of users) {
    if (u.email) byEmail.set(u.email.trim().toLowerCase(), String(u.id));
    const key = words(u.full_name ?? '');
    if (key) byName.set(key, [...(byName.get(key) ?? []), String(u.id)]);
  }
  const out = new Map<string, string>();
  for (const p of people) {
    if (p.isBot) continue;
    const email = p.email?.trim().toLowerCase();
    if (email && byEmail.has(email)) { out.set(p.ext, byEmail.get(email)!); continue; }
    const same = byName.get(words(p.name));
    if (same && same.length === 1) out.set(p.ext, same[0]);
  }
  return out;
}

/**
 * Кого пригласить: живые люди с почтой, которых нет в команде и которым ещё
 * не отправляли приглашение. Только участники ВЫБРАННЫХ чатов: переносят три канала
 * из сорока — не надо звать всю старую компанию.
 */
export function inviteList(
  people: ImportPerson[], matched: Map<string, string>, involved: Set<string>, pending: Set<string>,
): string[] {
  const out = new Set<string>();
  for (const p of people) {
    if (p.isBot || p.deleted || !p.email || matched.has(p.ext) || !involved.has(p.ext)) continue;
    const email = p.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || pending.has(email)) continue;
    out.add(email);
  }
  return [...out];
}

/**
 * Нарезка сообщений чата на пачки для вставки одним запросом.
 *
 * Скорость — из пачек: 10 000 сообщений — это 20 запросов по 500, а не 10 000
 * (условие «Готово» — меньше 15 минут). Но ответ в ветке ссылается на id корня, а
 * id появляется только после вставки. Поэтому пачку закрываем, как только
 * следующему сообщению нужен корень или цитата из неё же: корень всегда оказывается
 * в более ранней пачке, порядок сообщений (= порядок ленты) не меняется.
 */
export function splitBatches(messages: ImportMessage[], size = 500): ImportMessage[][] {
  const batches: ImportMessage[][] = [];
  const all = new Set(messages.map((m) => m.ext));
  let current: ImportMessage[] = [];
  let inCurrent = new Set<string>();
  for (const m of messages) {
    const deps = [m.threadExt, m.replyToExt].filter((d): d is string => !!d && d !== m.ext && all.has(d));
    if (current.length >= size || deps.some((d) => inCurrent.has(d))) {
      batches.push(current);
      current = [];
      inCurrent = new Set();
    }
    current.push(m);
    inCurrent.add(m.ext);
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Ключ сообщения в организации: по нему повтор импорта не создаёт дублей. */
export function messageKey(sourceKey: string, chatExt: string, msgExt: string): string {
  return `${sourceKey}:${chatExt}:${msgExt}`;
}

/**
 * Подпись автора, которого нет в команде. guest_name ограничен 60 символами;
 * пометку источника оставляем — по ней видно, что это не гость по ссылке.
 */
export function outsiderName(name: string, source: 'slack' | 'telegram'): string {
  const tag = source === 'slack' ? ' (Slack)' : ' (Telegram)';
  const clean = (name || 'Участник').replace(/\s+/g, ' ').trim();
  return `${clean.slice(0, 60 - tag.length)}${tag}`;
}
