/**
 * Источник регистрации (#4804): метки кампании и домен, откуда пришли.
 *
 * В отчёт по площадкам идут только агрегаты, поэтому здесь нет ничего личного —
 * значения кампании, приведённые к нижнему регистру (как в разборе логов сайта:
 * «Dzen» и «dzen» — одна площадка). Без меток — «direct», как просит ТЗ.
 */
export interface SignupAttribution {
  source: string;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  referrerHost: string | null;
}

const val = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase().slice(0, 200);
  return s || null;
};

/** Только домен: путь и параметры чужой страницы могут нести личное — их не храним. */
export function referrerHostOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let host = raw.trim().toLowerCase();
  try { if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname; } catch { return null; }
  host = host.replace(/^www\./, '').replace(/[:/].*$/, '');
  return /^[a-z0-9.-]{1,253}$/.test(host) && host.includes('.') ? host : null;
}

export function signupAttribution(utm: Record<string, string> | null | undefined, referrer?: unknown): SignupAttribution {
  return {
    source: val(utm?.utm_source) ?? 'direct',
    medium: val(utm?.utm_medium),
    campaign: val(utm?.utm_campaign),
    content: val(utm?.utm_content),
    referrerHost: referrerHostOf(referrer),
  };
}

/** Запись при первой регистрации: повтор для того же аккаунта ничего не меняет. */
export const SIGNUP_ATTRIBUTION_SQL = `
  INSERT INTO signup_attribution (account_id, tenant_id, user_id, signup_utm_source, signup_utm_medium,
                                  signup_utm_campaign, signup_utm_content, signup_referrer_host)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (account_id) DO NOTHING`;

export function attributionParams(accountId: unknown, tenantId: unknown, userId: unknown, a: SignupAttribution): unknown[] {
  return [accountId, tenantId, userId, a.source, a.medium, a.campaign, a.content, a.referrerHost];
}
