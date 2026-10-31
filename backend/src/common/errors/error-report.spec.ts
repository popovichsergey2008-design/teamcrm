import { fingerprint, routeOf, scrub, stackOf } from './error-report';

describe('сбор ошибок: очистка и группировка', () => {
  it('убирает токены, ключи, почту, телефоны и длинные числа', () => {
    const s = scrub('Bearer abc.def-123 eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2 sk_live_abcdefgh123 password=Secret1 boris@mail.ru +7 (999) 123-45-67 id 1234567');
    expect(s).not.toMatch(/abc\.def|eyJhbG|sk_live_abc|Secret1|boris@|999|1234567/);
    expect(s).toContain('Bearer <token>');
    expect(s).toContain('<email>');
    expect(s).toContain('<phone>');
  });
  it('короткие числа и обычный текст не трогает', () => {
    expect(scrub('Cannot read properties of undefined (reading "id") at line 42')).toBe('Cannot read properties of undefined (reading "id") at line 42');
  });
  it('путь без query и id', () => {
    expect(routeOf('/api/tasks/4705/files?token=x')).toBe('/api/tasks/:id/files');
    expect(routeOf('/meet/0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('/meet/:id');
  });
  it('одна ошибка с разными числами и версиями сборки — одна группа', () => {
    const a = fingerprint({ source: 'web', kind: 'TypeError', message: 'x is undefined in task 4705', stack: 'TypeError\n    at f (https://app.qevo.one/assets/Board-AbCd1234.js:1:200)', route: '/projects/:id' });
    const b = fingerprint({ source: 'web', kind: 'TypeError', message: 'x is undefined in task 4706', stack: 'TypeError\n    at f (https://app.qevo.one/assets/Board-ZzYy9876.js:1:310)', route: '/projects/:id' });
    const c = fingerprint({ source: 'web', kind: 'TypeError', message: 'другое', stack: '', route: '/projects/:id' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
  it('стек — несколько строк, без query', () => {
    expect(stackOf('E\n at a (/x.js?v=1:1:1)\n at b\n at c', 2)).toBe('E\n at a (/x.js:1:1)');
    expect(stackOf(null)).toBeNull();
  });
});
