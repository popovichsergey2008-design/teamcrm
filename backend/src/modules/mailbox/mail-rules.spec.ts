import { categorize, mailBriefLine, triageText } from './mail-rules';

const base = { fromEmail: 'ivan@acme.ru', fromName: 'Иван', subject: 'Привет', body: 'Как дела', listUnsubscribe: false, clientName: null, vip: false };

describe('mail-rules: категории', () => {
  it('рассылка — по отписке и адресу робота', () => {
    expect(categorize({ ...base, listUnsubscribe: true }).category).toBe('newsletter');
    expect(categorize({ ...base, fromEmail: 'noreply@shop.ru' }).category).toBe('newsletter');
  });

  it('срочное и VIP — важно, но не у роботов', () => {
    expect(categorize({ ...base, subject: 'Срочно: договор' })).toEqual({ category: 'critical', reason: 'срочные слова в письме' });
    expect(categorize({ ...base, vip: true }).category).toBe('critical');
    expect(categorize({ ...base, vip: true, listUnsubscribe: true }).category).toBe('newsletter');
  });

  it('счёт, клиент, просьба, к сведению', () => {
    expect(categorize({ ...base, subject: 'Счёт на оплату №45' }).category).toBe('invoice');
    expect(categorize({ ...base, subject: 'Invoice 2026-10', fromEmail: 'billing@aws.com' }).category).toBe('invoice');
    expect(categorize({ ...base, clientName: 'Acme' })).toEqual({ category: 'client', reason: 'клиент Acme' });
    expect(categorize({ ...base, body: 'Прошу подтвердить встречу' }).category).toBe('action');
    expect(categorize({ ...base, body: 'Когда будет готово?' }).category).toBe('action');
    expect(categorize(base).category).toBe('fyi');
  });
});

describe('mail-rules: тексты', () => {
  it('разбор: важное списком, рассылки числом', () => {
    const text = triageText([
      { id: '1', fromName: 'Иван', fromEmail: null, subject: 'Срочно', category: 'critical', reason: null },
      { id: '2', fromName: null, fromEmail: 'news@x.ru', subject: 'Скидки', category: 'newsletter', reason: null },
      { id: '3', fromName: null, fromEmail: 'news@y.ru', subject: 'Акция', category: 'newsletter', reason: null },
    ])!;
    expect(text).toContain('Важно (1):\n— #1 Иван: «Срочно»');
    expect(text).toContain('Рассылки: 2');
    expect(triageText([])).toBeNull();
  });

  it('строка сводки — только то, что требует внимания', () => {
    expect(mailBriefLine({ critical: 1, action: 2, newsletter: 30 })).toBe('Почта (непрочитанное): важных 1, ждут действия 2');
    expect(mailBriefLine({ fyi: 3, newsletter: 9 })).toBeNull();
  });
});
