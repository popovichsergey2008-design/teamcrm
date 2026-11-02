/**
 * Консоль поддержки (§6): что сказать оператору о тарифе и ИИ клиента. Чистые функции —
 * под тестами. Оператор видит состояние и ПРИЧИНУ отказа, но не ключи и не цены (§7).
 */

export interface AiFacts {
  /** Свой ключ компании (любой провайдер). */
  own: boolean;
  /** Выключатели владельца платформы. */
  guard: { any: boolean; shared: boolean; reason: string | null };
  /** Пробный ИИ общим ключом; null — общего ключа на сервере нет. */
  trial: { allowed: boolean; reason: 'platform' | 'trial' | 'expired' | 'exhausted'; endsAt: Date | null; tokensUsed: number; tokensLimit: number | null } | null;
}

export interface AiState {
  state: 'own' | 'trial' | 'off';
  text: string;
}

const day = (d: Date) => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
const num = (n: number) => n.toLocaleString('ru-RU');

/** Работает ли ИИ у клиента и почему нет — словами для оператора. */
export function aiState(f: AiFacts): AiState {
  if (!f.guard.any) return { state: 'off', text: `ИИ выключен на всей платформе${f.guard.reason ? `: ${f.guard.reason}` : ''}` };
  if (f.own) return { state: 'own', text: 'Свой ключ компании — лимиты у провайдера клиента' };
  if (!f.guard.shared) return { state: 'off', text: `Общий ключ выключен владельцем платформы${f.guard.reason ? `: ${f.guard.reason}` : ''}; своего ключа у компании нет` };
  if (!f.trial) return { state: 'off', text: 'Своего ключа нет, общего ключа на сервере нет' };
  const t = f.trial;
  if (t.reason === 'platform') return { state: 'trial', text: 'Площадка вендора — общий ключ без потолка' };
  if (t.reason === 'expired') return { state: 'off', text: `Пробный период ИИ закончился${t.endsAt ? ` ${day(t.endsAt)}` : ''}; нужен свой ключ` };
  if (t.reason === 'exhausted') return { state: 'off', text: `Пробные токены израсходованы (${num(t.tokensUsed)}${t.tokensLimit ? ` из ${num(t.tokensLimit)}` : ''}); нужен свой ключ` };
  const left = t.tokensLimit != null ? Math.max(0, t.tokensLimit - t.tokensUsed) : null;
  return {
    state: 'trial',
    text: `Пробный ИИ${t.endsAt ? ` до ${day(t.endsAt)}` : ''}${left != null ? `, осталось ${num(left)} токенов` : ''}`,
  };
}

export const SUB_TEXT: Record<string, string> = {
  TRIAL: 'Пробный период',
  ACTIVE: 'Оплачено',
  GRACE: 'Льготные дни после окончания',
  READ_ONLY: 'Только чтение — подписка закончилась',
};
