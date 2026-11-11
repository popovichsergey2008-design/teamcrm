/**
 * Имя для «Добрый день, …!» (ТЗ 10.11). Пока человек не ввёл имя в окне «Давайте
 * познакомимся», вместо имени стоит начало почты («qevo.test.claude.1110d») — такое
 * приветствие хуже, чем без имени. Значит, без имени: «Добрый день!».
 */
export function helloName(u: { fullName?: string | null; email?: string | null; uiPrefs?: { setupNames?: unknown } | null } | null | undefined): string {
  if (!u || u.uiPrefs?.setupNames) return '';
  const first = String(u.fullName ?? '').trim().split(/\s+/)[0] ?? '';
  if (!first || first === String(u.email ?? '').split('@')[0]) return '';
  return first;
}
