/**
 * Подпись присутствия под именем в Chat Bar.
 *
 * Правила простые, но ошибаются молча — поэтому здесь, под проверкой логики:
 * «занят» важнее «в сети» (человек поставил его нарочно), «на мите» важнее
 * «занят» (это факт, а не пожелание), а «был N минут назад» показывается только
 * тому, кто не в сети, — иначе подпись врёт.
 */

export type ManualStatus = 'busy' | 'away' | null | undefined;

export interface PresenceInput {
  online?: boolean;
  status?: ManualStatus;
  /** Идёт созвон с участием человека. */
  onCall?: boolean;
  lastSeenAt?: string | Date | null;
}

export type PresenceKind = 'online' | 'busy' | 'away' | 'meeting' | 'offline';

export function presenceKind(p: PresenceInput): PresenceKind {
  if (p.onCall) return 'meeting';
  if (p.status === 'busy') return 'busy';
  if (p.status === 'away') return 'away';
  return p.online ? 'online' : 'offline';
}

/** «12 мин назад», «3 ч назад», «вчера», «5 сентября». */
export function agoLabel(at: string | Date, now = new Date()): string {
  const d = new Date(at);
  const diff = Math.max(0, now.getTime() - d.getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hours = Math.floor(min / 60);
  if (hours < 24 && d.toDateString() === now.toDateString()) return `${hours} ч назад`;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return 'вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

export function presenceLabel(p: PresenceInput, now = new Date()): string {
  switch (presenceKind(p)) {
    case 'meeting': return 'на мите';
    case 'busy': return 'занят';
    case 'away': return 'отошёл';
    case 'online': return 'в сети';
    default: return p.lastSeenAt ? `был(а) ${agoLabel(p.lastSeenAt, now)}` : 'не в сети';
  }
}
