import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Одноразовые коды по времени (TOTP, RFC 6238) — то, что показывают Google
 * Authenticator, Яндекс Ключ, 1Password и прочие приложения-генераторы.
 *
 * Своя реализация на двадцать строк вместо пакета: алгоритм стандартный и проверяется
 * тестовыми векторами из самого RFC (см. totp.spec.ts). SHA-1, 6 цифр, шаг 30 секунд —
 * это то, что понимают все приложения; любые «улучшения» ломают совместимость.
 */
export const TOTP_STEP_SEC = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Новый секрет: 20 байт, как у большинства сервисов, в base32 для приложения. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Код для шага времени (HOTP от номера шага, RFC 4226). */
export function totpAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(bin).padStart(DIGITS, '0');
}

export function stepOf(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SEC);
}

/**
 * Проверка кода. Допуск ±1 шаг — часы телефона и сервера расходятся на десяток секунд.
 * Возвращает шаг, на котором код совпал (его запоминаем, чтобы код не прошёл дважды),
 * или null. Шаги не новее lastStep не принимаются.
 */
export function verifyTotp(secretB32: string, code: string, atMs: number, lastStep?: number | null): number | null {
  const clean = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const now = stepOf(atMs);
  for (const step of [now, now - 1, now + 1]) {
    if (lastStep != null && step <= lastStep) continue;
    const expected = Buffer.from(totpAt(secretB32, step));
    if (timingSafeEqual(expected, Buffer.from(clean))) return step;
  }
  return null;
}

/** Ссылка для QR-кода: её понимают все приложения-генераторы. */
export function otpauthUri(secretB32: string, account: string, issuer = 'QEVO'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_SEC}`;
}

/** Резервные коды: 10 штук вида abcd-efgh, без похожих символов. */
export function newRecoveryCodes(n = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => {
    const bytes = randomBytes(8);
    const s = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export function normalizeRecoveryCode(code: string): string {
  return String(code ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}
