/**
 * Запись о звонке в чате (#4907): «Звонок шёл 5 минут 14 секунд · 13 ноября, 13:08»,
 * «Пропущенный звонок», «Звонок отклонён» — как в Telegram. Чистая функция.
 */

const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};

export function durationRu(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
  const parts = [
    h ? `${h} ${plural(h, 'час', 'часа', 'часов')}` : '',
    m ? `${m} ${plural(m, 'минуту', 'минуты', 'минут')}` : '',
    r || (!h && !m) ? `${r} ${plural(r, 'секунду', 'секунды', 'секунд')}` : '',
  ].filter(Boolean);
  return parts.join(' ');
}

export type CallOutcome = 'done' | 'missed' | 'declined';

export function callNote(outcome: CallOutcome, startedAt: Date, sec: number, tz: string): string {
  // дата и время отдельно: склейку («13 ноября в 13:08» или «13 ноября, 13:08») версии Node делают по-разному
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'long' }).format(startedAt);
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(startedAt);
  const when = `${day}, ${time}`;
  if (outcome === 'done') return `📞 Звонок шёл ${durationRu(sec)} · ${when}`;
  if (outcome === 'declined') return `📞 Звонок отклонён · ${when}`;
  return `📞 Пропущенный звонок · ${when}`;
}

/** Состоялся ли разговор: кроме звонившего в комнате был хотя бы ещё один сотрудник. */
export function outcomeOf(participants: number, declined: boolean): CallOutcome {
  if (participants >= 2) return 'done';
  return declined ? 'declined' : 'missed';
}
