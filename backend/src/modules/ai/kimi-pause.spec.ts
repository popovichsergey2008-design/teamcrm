import { isKimiAccountError, kimiPaused, noteKimiResult } from './ai.provider';

describe('Kimi на паузе, пока не пополнят счёт (19.11.2026)', () => {
  const key = 'sk-test-kimi-0123456789';
  it('нет денег — пауза 10 минут, потом проверяем снова', () => {
    const t = 1_000_000;
    noteKimiResult(key, 'Your account org-x is suspended due to insufficient balance, please recharge', t);
    expect(kimiPaused(key, t + 60_000)).toBe(true);
    expect(kimiPaused(key, t + 10 * 60_000 + 1)).toBe(false);
  });
  it('ответ пришёл — пауза снята сразу', () => {
    noteKimiResult(key, 'insufficient balance', Date.now());
    expect(kimiPaused(key)).toBe(true);
    noteKimiResult(key, null);
    expect(kimiPaused(key)).toBe(false);
  });
  it('обычный сбой (таймаут, 500) паузу не ставит', () => {
    expect(isKimiAccountError('HTTP 500')).toBe(false);
    expect(isKimiAccountError('The operation was aborted due to timeout')).toBe(false);
    expect(isKimiAccountError('HTTP 401')).toBe(true);
    noteKimiResult('another-key-xyz', 'HTTP 503');
    expect(kimiPaused('another-key-xyz')).toBe(false);
  });
});
