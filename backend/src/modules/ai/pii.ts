/**
 * Маскирование PII (master → Data Masking; Этап 3, Шаг 3.2).
 * Заменяет e-mail, телефоны, пароли/секреты и длинные числовые
 * последовательности (карты) плейсхолдерами ДО отправки текста во внешний LLM.
 * Чистая функция — покрыта unit-тестами; egress в ai.service неотключаем.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// "пароль: X" / "password is X" / "pin 1234"
// без \b: в JS \b опирается на ASCII \w и не работает с кириллицей ("пароль")
const SECRET = /(парол[а-яё]*|password|passwd|pwd|пин[\s-]?код|pin)\s*(?:[:=-]|это|—)?\s*\S+/gi;
// длинные числовые последовательности (телефоны/карты/счета) с любыми разделителями;
// решение PHONE vs NUMBER принимается по числу цифр в функции-заменителе
const NUMRUN = /\+?\d[\d\s\-()]{7,}\d/g;

export interface MaskResult {
  masked: string;
  counts: { email: number; phone: number; secret: number; number: number };
}

export function maskPII(input: string): MaskResult {
  let email = 0;
  let phone = 0;
  let secret = 0;
  let number = 0;
  let text = input;

  text = text.replace(SECRET, () => {
    secret++;
    return '[SECRET]';
  });
  text = text.replace(EMAIL, () => {
    email++;
    return '[EMAIL]';
  });
  text = text.replace(NUMRUN, (m) => {
    const digits = (m.match(/\d/g) || []).length;
    if (digits < 10) return m; // короткие числа (id задач, минуты) не трогаем
    if (digits >= 13) {
      number++;
      return '[NUMBER]';
    }
    phone++;
    return '[PHONE]';
  });

  return { masked: text, counts: { email, phone, secret, number } };
}
