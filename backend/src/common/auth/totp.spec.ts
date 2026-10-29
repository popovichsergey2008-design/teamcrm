import { base32Decode, base32Encode, newRecoveryCodes, normalizeRecoveryCode, otpauthUri, stepOf, totpAt, verifyTotp } from './totp';
import { passwordProblem } from './password-policy';

// RFC 6238, приложение B: секрет "12345678901234567890" (ASCII), SHA-1, 8 цифр.
// У нас 6 цифр — это последние 6 из восьмизначного кода.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
];

describe('TOTP', () => {
  it('совпадает с тестовыми векторами RFC 6238', () => {
    for (const [t, code8] of VECTORS) {
      expect(totpAt(RFC_SECRET, stepOf(t * 1000))).toBe(code8.slice(-6));
    }
  });

  it('base32 туда и обратно', () => {
    const buf = Buffer.from('any bytes \x00\xff here');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it('принимает соседний шаг и не принимает тот же код повторно', () => {
    const at = 1_700_000_000_000;
    const now = stepOf(at);
    const prev = totpAt(RFC_SECRET, now - 1);
    expect(verifyTotp(RFC_SECRET, prev, at)).toBe(now - 1);
    expect(verifyTotp(RFC_SECRET, prev, at, now - 1)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 3), at)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12 34', at)).toBeNull();
  });

  it('пробелы в коде не мешают', () => {
    const at = 1_700_000_000_000;
    const code = totpAt(RFC_SECRET, stepOf(at));
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, at)).toBe(stepOf(at));
  });

  it('ссылка для QR-кода', () => {
    expect(otpauthUri('ABC', 'a@b.c')).toBe('otpauth://totp/QEVO%3Aa%40b.c?secret=ABC&issuer=QEVO&algorithm=SHA1&digits=6&period=30');
  });

  it('резервные коды разные и нормализуются', () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(normalizeRecoveryCode(' ABCD-efgh ')).toBe('abcdefgh');
  });
});

describe('passwordProblem', () => {
  it('длина и частые пароли', () => {
    expect(passwordProblem('short')).toMatch(/не менее 8/);
    expect(passwordProblem('password123')).toMatch(/распространён/);
    expect(passwordProblem('QWERTYUIOP')).toMatch(/распространён/);
    expect(passwordProblem('aaaaaaaaaa')).toMatch(/повторяющегося/);
  });
  it('не совпадает с почтой', () => {
    expect(passwordProblem('ivan.petrov', 'ivan.petrov@mail.ru')).toMatch(/почтой/);
    expect(passwordProblem('ivan.petrov@mail.ru', 'ivan.petrov@mail.ru')).toMatch(/почтой/);
  });
  it('нормальная фраза проходит', () => {
    expect(passwordProblem('кот любит молоко', 'a@b.c')).toBeNull();
    expect(passwordProblem('Test-pass-2026')).toBeNull();
  });
});
