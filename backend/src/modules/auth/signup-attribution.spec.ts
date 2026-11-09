import { referrerHostOf, signupAttribution } from './signup-attribution';

describe('источник регистрации (#4804)', () => {
  it('метки — в нижнем регистре, без меток — direct', () => {
    expect(signupAttribution({ utm_source: 'Dzen', utm_medium: 'article', utm_campaign: 'protokol-planerki' }))
      .toEqual({ source: 'dzen', medium: 'article', campaign: 'protokol-planerki', content: null, referrerHost: null });
    expect(signupAttribution(undefined).source).toBe('direct');
    expect(signupAttribution({ utm_medium: 'x' }).source).toBe('direct');
  });

  it('от источника — только домен', () => {
    expect(referrerHostOf('https://www.dzen.ru/a/xyz?u=1')).toBe('dzen.ru');
    expect(referrerHostOf('vk.com')).toBe('vk.com');
    expect(referrerHostOf('javascript:alert(1)')).toBeNull();
    expect(referrerHostOf('')).toBeNull();
    expect(referrerHostOf('localhost')).toBeNull();
  });
});
