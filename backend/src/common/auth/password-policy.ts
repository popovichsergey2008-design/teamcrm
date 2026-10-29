import { AppException } from '../http/app-exception';

/**
 * Требования к паролю (мастер-план §19, NIST 800-63B).
 *
 * Ставка на длину, а не на «одну заглавную и один символ»: такие правила дают
 * «Password1!», который подбирается первым. Вместо них — запрет самых частых паролей
 * и пароля, повторяющего почту. Вставка из менеджера паролей не запрещается нигде.
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

// Самые частые пароли из открытых утечек — те, что перебирают первыми.
const COMMON = new Set([
  '12345678', '123456789', '1234567890', '12345678910', '123123123', '11111111', '00000000',
  '87654321', '11223344', '12341234', '1q2w3e4r', '1q2w3e4r5t', '1qaz2wsx', 'qwertyui',
  'qwertyuiop', 'qwerty123', 'qwerty1234', 'qwerty12345', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1',
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd',
  'p@ssword', 'iloveyou', 'iloveyou1', 'sunshine', 'princess', 'football', 'baseball',
  'welcome1', 'welcome123', 'admin123', 'administrator', 'letmein1', 'abc12345', 'abcd1234',
  'abcdefgh', 'aa123456', 'monkey12', 'dragon12', 'master12', 'superman', 'michael1',
  'trustno1', 'whatever', 'computer', 'internet', 'starwars', 'changeme', 'default1',
  'qazwsxedc', 'zaq12wsx', '1234qwer', 'q1w2e3r4', 'q1w2e3r4t5', 'a1b2c3d4', 'samsung1',
  'qwe123qwe', 'qweasdzxc', '123qweasd', '123qwe123', 'ytrewq123', 'йцукенгш', 'пароль123',
  'привет123', 'qwertyqwerty', '666666666', '7777777777', '55555555', '99999999', '88888888',
]);

/** Причина отказа или null, если пароль годится. Без зависимостей — удобно тестировать. */
export function passwordProblem(password: string, email?: string | null): string | null {
  const p = String(password ?? '');
  if (p.length < PASSWORD_MIN) return `Пароль должен содержать не менее ${PASSWORD_MIN} символов`;
  if (p.length > PASSWORD_MAX) return `Пароль слишком длинный (максимум ${PASSWORD_MAX} символов)`;
  const low = p.toLowerCase();
  if (COMMON.has(low)) return 'Этот пароль слишком распространён — его подбирают первым. Придумайте другой';
  if (/^(.)\1+$/.test(p)) return 'Пароль из одного повторяющегося символа слишком простой';
  const local = String(email ?? '').split('@')[0].toLowerCase();
  if (local.length >= 4 && (low === local || low === String(email).toLowerCase())) {
    return 'Пароль не должен совпадать с почтой';
  }
  return null;
}

export function assertPasswordStrong(password: string, email?: string | null): void {
  const problem = passwordProblem(password, email);
  if (problem) throw AppException.validation(problem);
}
