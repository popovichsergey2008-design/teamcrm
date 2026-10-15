import { checkUrl, htmlToText, isPrivateIp, safeFetch, UnsafeUrlError } from './safe-fetch';

describe('safeFetch: внутренние адреса недоступны (ТЗ-33, §49)', () => {
  it('частные, служебные и локальные адреса', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect([ip, isPrivateIp(ip)]).toEqual([ip, true]);
    }
    for (const ip of ['8.8.8.8', '109.199.99.13', '172.32.0.1', '2a00:1450:4010::64']) {
      expect([ip, isPrivateIp(ip)]).toEqual([ip, false]);
    }
  });

  it('ссылки: только http(s), без логина, без внутренних имён и портов', () => {
    expect(checkUrl('https://example.com/page').hostname).toBe('example.com');
    for (const bad of ['file:///etc/passwd', 'ftp://example.com', 'http://localhost/x', 'http://127.0.0.1/', 'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/', 'http://user:pw@example.com/', 'http://example.com:22/', 'http://intranet/',
      'http://crm-postgres:5432/', 'http://metadata.google.internal/', 'gopher://x']) {
      expect(() => checkUrl(bad)).toThrow(UnsafeUrlError);
    }
  });

  it('до запроса не доходит: адрес во внутреннюю сеть отклоняется', async () => {
    await expect(safeFetch('http://127.0.0.1:8080/')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(safeFetch('http://10.0.0.5/')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('страница → текст: без скриптов и стилей, с заголовком', () => {
    const r = htmlToText('<html><head><title> Цены </title><style>.a{}</style></head><body><script>alert(1)</script><h1>Тарифы</h1><p>Базовый&nbsp;— 399&#8381;</p></body></html>');
    expect(r.title).toBe('Цены');
    expect(r.text).toContain('Тарифы');
    expect(r.text).toContain('Базовый — 399₽');
    expect(r.text).not.toContain('alert');
  });
});
