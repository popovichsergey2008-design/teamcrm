/**
 * Правила консолей платформы (ТЗ QEVO_PLATFORM_CONSOLES_SPEC): какие консоли есть,
 * какие права даёт роль, как считать отчётный период. Чистые функции — под тестами.
 */

export const PC_APPS = ['owner', 'developer', 'support'] as const;
export type PcApp = (typeof PC_APPS)[number];
export const isPcApp = (v: unknown): v is PcApp => typeof v === 'string' && (PC_APPS as readonly string[]).includes(v);

/** Роль = доступ к одноимённой консоли. Доступ в одну не даёт доступа в остальные (§3). */
export type PcRole = PcApp;

/**
 * Права делятся на view / manage / execute (§7); невыданное запрещено.
 * staff.manage — одобрять регистрации и раздавать роли: только у владельца.
 */
export type PcPerm =
  | 'owner.view' | 'owner.manage' | 'staff.manage'
  | 'dev.view' | 'dev.execute'
  | 'support.view';

const ROLE_PERMS: Record<PcRole, PcPerm[]> = {
  owner: ['owner.view', 'owner.manage', 'staff.manage'],
  developer: ['dev.view'],
  support: ['support.view'],
};

/** Права в конкретной консоли: только от роли этой консоли. */
export function permsFor(roles: readonly string[], app: PcApp): PcPerm[] {
  return roles.includes(app) ? ROLE_PERMS[app] : [];
}

export function canEnter(roles: readonly string[], app: PcApp): boolean {
  return roles.includes(app);
}

export const APP_TITLE: Record<PcApp, string> = {
  owner: 'Консоль владельца',
  developer: 'Консоль разработчика',
  support: 'Консоль поддержки',
};

// ── Период отчёта ───────────────────────────────────────────────────────────

export type PeriodKey = 'today' | 'yesterday' | '7d' | 'month' | 'prev_month' | 'year' | 'custom';
export const PERIODS: PeriodKey[] = ['today', 'yesterday', '7d', 'month', 'prev_month', 'year', 'custom'];

/** Календарная дата YYYY-MM-DD в поясе tz. */
export function dateIn(tz: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

const addDays = (d: string, n: number): string => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface Period {
  /** Первый день включительно и день ПОСЛЕ последнего — в отчётном поясе. */
  from: string;
  to: string;
  /** Равный предыдущий период — для сравнения (§5.1). */
  prevFrom: string;
  prevTo: string;
  days: number;
}

/**
 * Границы периода — в отчётном поясе, хранение — в UTC (§5.1). Возвращаем календарные
 * даты, а SQL переводит их в моменты через `AT TIME ZONE`, — так сутки «сегодня»
 * в Москве не съезжают на три часа.
 */
export function periodOf(key: PeriodKey, tz: string, now: Date, custom?: { from?: string; to?: string }): Period {
  const today = dateIn(tz, now);
  let from: string;
  let to: string;
  switch (key) {
    case 'today': from = today; to = addDays(today, 1); break;
    case 'yesterday': from = addDays(today, -1); to = today; break;
    case '7d': from = addDays(today, -6); to = addDays(today, 1); break;
    case 'month': from = `${today.slice(0, 8)}01`; to = addDays(today, 1); break;
    case 'prev_month': {
      to = `${today.slice(0, 8)}01`;
      from = `${addDays(to, -1).slice(0, 8)}01`;
      break;
    }
    case 'year': from = `${today.slice(0, 4)}-01-01`; to = addDays(today, 1); break;
    case 'custom': {
      const ok = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
      if (!ok(custom?.from) || !ok(custom?.to)) throw new Error('period');
      from = custom!.from!;
      to = addDays(custom!.to!, 1);
      if (daysBetween(from, to) < 1 || daysBetween(from, to) > 3700) throw new Error('period');
      break;
    }
    default: throw new Error('period');
  }
  const days = daysBetween(from, to);
  return { from, to, prevFrom: addDays(from, -days), prevTo: from, days };
}

/** Часовой пояс отчёта: только существующий, иначе Москва. */
export function safeTz(tz: unknown): string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return 'Europe/Moscow';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return 'Europe/Moscow'; }
}

/** Изменение к прошлому периоду, %: нет базы — null («нет данных», а не 0 и не ∞). */
export function deltaPct(cur: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}
