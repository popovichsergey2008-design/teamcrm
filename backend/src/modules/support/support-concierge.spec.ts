import { engineerStatus, parseResolution, sanitizeFailedRequests, sanitizeTelemetry, waitEstimate } from './support-concierge';

const base = { online: true, manual: null, inHuddle: false, load: 0, maxLoad: 5, hasShifts: false, onShift: false };

describe('статус инженера', () => {
  it('не в сети или вне смены — «не в сети», что бы ни стояло вручную', () => {
    expect(engineerStatus({ ...base, online: false, manual: 'available' })).toBe('offline');
    expect(engineerStatus({ ...base, hasShifts: true, onShift: false })).toBe('offline');
    expect(engineerStatus({ ...base, hasShifts: true, onShift: true })).toBe('available');
  });
  it('отошёл, созвон, занят, загрузка', () => {
    expect(engineerStatus({ ...base, manual: 'away', inHuddle: true })).toBe('away');
    expect(engineerStatus({ ...base, inHuddle: true })).toBe('in_huddle');
    expect(engineerStatus({ ...base, manual: 'busy' })).toBe('busy');
    expect(engineerStatus({ ...base, load: 5 })).toBe('busy');
  });
});

describe('оценка ожидания', () => {
  it('свободен и очереди нет — медиана или «меньше минуты»', () => {
    expect(waitEstimate({ available: 1, online: 1, queue: 0, medianSec: 16 }).text).toBe('Среднее время ответа: ~ 15 секунд');
    expect(waitEstimate({ available: 1, online: 1, queue: 0, medianSec: null }).text).toBe('Обычно отвечаем меньше чем за минуту');
    expect(waitEstimate({ available: 1, online: 1, queue: 0, medianSec: 400 }).kind).toBe('now');
  });
  it('все заняты — диапазон по очереди; никого — честно', () => {
    expect(waitEstimate({ available: 0, online: 1, queue: 0, medianSec: 20 })).toMatchObject({ kind: 'queue', minutes: [3, 5] });
    expect(waitEstimate({ available: 0, online: 2, queue: 5, medianSec: 20 }).minutes).toEqual([9, 11]);
    expect(waitEstimate({ available: 0, online: 0, queue: 3, medianSec: 20 }).kind).toBe('offline');
  });
});

describe('итог и диагностика', () => {
  it('итог от модели — четыре поля; мусор — null', () => {
    expect(parseResolution('Итог: {"problem":"Не видно протокол","fixed":"Привязали к проекту","checked":"Тест прошёл","next":""}'))
      .toEqual({ problem: 'Не видно протокол', fixed: 'Привязали к проекту', checked: 'Тест прошёл', next: '' });
    expect(parseResolution('не JSON')).toBeNull();
  });
  it('неудачные запросы — без параметров, токенов и мусора, не больше пяти', () => {
    const list = sanitizeFailedRequests([
      { method: 'post', path: '/api/projects/130/settings?token=secret', status: 403, requestId: 'req_abc123', at: '2026-10-12T10:00:00Z' },
      { method: 'GET', path: '/api/meet/guest/AbCdEfGhIjKlMnOpQrStUvWxYz', status: 401 },
      { method: 'HACK', path: '/x', status: 500 },
      { method: 'GET', path: 'no-slash', status: 500 },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ method: 'POST', path: '/api/projects/130/settings', status: 403, requestId: 'req_abc123' });
    expect(list[1].path).toBe('/api/meet/guest/:token');
    expect(sanitizeFailedRequests(Array.from({ length: 9 }, () => ({ method: 'GET', path: '/a', status: 500 })))).toHaveLength(5);
  });

  it('ТЗ-34: телеметрия экрана — только размеры, ориентация и короткое название', () => {
    expect(sanitizeTelemetry({ screen: '390×844', viewport: '390×700', orientation: 'portrait', dpr: 3, entityTitle: '  Отчёт   за неделю ' }))
      .toEqual({ screen: '390×844', viewport: '390×700', orientation: 'portrait', dpr: 3, entityTitle: 'Отчёт за неделю' });
    expect(sanitizeTelemetry({ screen: '<script>', orientation: 'вбок', token: 'secret' })).toBeNull();
    expect(sanitizeTelemetry('строка')).toBeNull();
    expect(sanitizeTelemetry({ entityTitle: 'x'.repeat(500) })?.entityTitle).toHaveLength(120);
  });
});
