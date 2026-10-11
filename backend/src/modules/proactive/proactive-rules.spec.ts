import { batchLine, compareRank, confidenceBand, deliveryFor, fingerprint, rankKey, snoozeTarget } from './proactive-rules';

describe('ящик предложений: правила', () => {
  it('отпечаток не зависит от регистра и пунктуации', () => {
    const a = fingerprint({ skill: 'commitment', sourceType: 'chat', sourceId: '5', intent: 'Пришлю смету сегодня!', entity: 'u:11' });
    const b = fingerprint({ skill: 'commitment', sourceType: 'chat', sourceId: '5', intent: 'пришлю  смету сегодня', entity: 'u:11' });
    expect(a).toBe(b);
  });

  it('уведомления: P0 всегда пушем, в фокусе P1 значком, P2 молча, сверх лимита молча', () => {
    expect(deliveryFor({ priority: 0, quiet: true, level: 'normal', sentToday: 99, dailyLimit: 12 })).toBe('push');
    expect(deliveryFor({ priority: 1, quiet: true, level: 'normal', sentToday: 0, dailyLimit: 12 })).toBe('badge');
    expect(deliveryFor({ priority: 2, quiet: true, level: 'normal', sentToday: 0, dailyLimit: 12 })).toBe('silent');
    expect(deliveryFor({ priority: 1, quiet: false, level: 'normal', sentToday: 0, dailyLimit: 12 })).toBe('push');
    expect(deliveryFor({ priority: 2, quiet: false, level: 'normal', sentToday: 0, dailyLimit: 12 })).toBe('badge');
    expect(deliveryFor({ priority: 1, quiet: false, level: 'normal', sentToday: 12, dailyLimit: 12 })).toBe('silent');
    expect(deliveryFor({ priority: 1, quiet: false, level: 'quiet', sentToday: 0, dailyLimit: 12 })).toBe('silent');
  });

  it('отложить: после обеда и завтра (из пятницы — понедельник)', () => {
    expect(snoozeTarget('afternoon', { date: '2026-10-12', hour: 10, minute: 0, isoDow: 1 })).toEqual({ kind: 'local', date: '2026-10-12', time: '14:00' });
    expect(snoozeTarget('afternoon', { date: '2026-10-12', hour: 15, minute: 0, isoDow: 1 })).toEqual({ kind: 'local', date: '2026-10-13', time: '14:00' });
    expect(snoozeTarget('tomorrow', { date: '2026-10-16', hour: 18, minute: 0, isoDow: 5 })).toEqual({ kind: 'local', date: '2026-10-19', time: '09:00' });
    expect(snoozeTarget('hour', { date: '2026-10-12', hour: 10, minute: 0, isoDow: 1 })).toEqual({ kind: 'relative', minutes: 60 });
  });

  it('порядок: приоритет, срок, уверенность, свежесть', () => {
    const now = '2026-10-12T10:00:00Z';
    const a = rankKey({ priority: 1, dueAt: '2026-10-13T10:00:00Z', confidence: 0.8, createdAt: now });
    const b = rankKey({ priority: 1, dueAt: '2026-10-12T18:00:00Z', confidence: 0.7, createdAt: now });
    const c = rankKey({ priority: 0, dueAt: null, confidence: 0.7, createdAt: now });
    expect([a, b, c].sort(compareRank)).toEqual([c, b, a]);
  });

  it('уверенность: порог 0,70, для критичных полей 0,85', () => {
    expect(confidenceBand(0.65)).toBe('skip');
    expect(confidenceBand(0.8)).toBe('hedged');
    expect(confidenceBand(0.8, true)).toBe('skip');
    expect(confidenceBand(0.95, true)).toBe('strong');
  });

  it('свод: «нашёл 4 вопроса»', () => {
    expect(batchLine({ commitment: 3, reply: 1 })).toBe('Секретарь нашёл 4 вопроса, требующих внимания.');
    expect(batchLine({})).toBeNull();
  });
});
