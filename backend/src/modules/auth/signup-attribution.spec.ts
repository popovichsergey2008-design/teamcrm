import { referralCodeOf, referrerHostOf, signupAttribution } from './signup-attribution';

describe('источник регистрации (#4804)', () => {
  it('метки — в нижнем регистре, без меток — direct', () => {
    expect(signupAttribution({ utm_source: 'Dzen', utm_medium: 'article', utm_campaign: 'protokol-planerki' }))
      .toEqual({ source: 'dzen', medium: 'article', campaign: 'protokol-planerki', content: null, term: null, referrerHost: null, referralCode: null });
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

  it('#4863: utm_term и код приглашения из ссылки сайта', () => {
    const a = signupAttribution({ utm_source: 'share', utm_term: 'Планёрка' }, 'vk.com', 'Q7K2M9');
    expect(a.term).toBe('планёрка');
    expect(a.referralCode).toBe('Q7K2M9');
    expect(referralCodeOf('<script>')).toBeNull();
    expect(referralCodeOf('ab')).toBeNull();
  });
});
