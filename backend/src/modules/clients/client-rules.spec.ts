import { clientHealth, clientSummary, normalizeDomain, normalizeEmail, normalizeName, normalizePhone } from './client-rules';

describe('нормализация для поиска дублей', () => {
  it('почта — нижний регистр без пробелов', () => {
    expect(normalizeEmail('  Ivan@Acme.COM ')).toBe('ivan@acme.com');
    expect(normalizeEmail('не почта')).toBeNull();
  });

  it('российский телефон приводится к +7', () => {
    expect(normalizePhone('8 (999) 123-45-67')).toBe('+79991234567');
    expect(normalizePhone('+7 999 123 45 67')).toBe('+79991234567');
    expect(normalizePhone('9991234567')).toBe('+79991234567');
    expect(normalizePhone('+49 30 1234567')).toBe('+49301234567');
    expect(normalizePhone('123')).toBeNull();
  });

  it('домен — без www и пути; почтовые сервисы — не домен компании', () => {
    expect(normalizeDomain('https://www.Acme.com/about')).toBe('acme.com');
    expect(normalizeDomain('ivan@acme.com')).toBe('acme.com');
    expect(normalizeDomain('ivan@gmail.com')).toBeNull();
  });

  it('название без формы собственности и кавычек', () => {
    expect(normalizeName('ООО «Ромашка»')).toBe('ромашка');
    expect(normalizeName('Acme GmbH')).toBe('acme');
    expect(normalizeName('ИП Иванов И.И.')).toBe('иванов и и');
  });
});

describe('здоровье клиента — только по понятным сигналам', () => {
  const base = { overdueTasks: 0, daysSinceActivity: 2, dealStalledDays: null, status: 'active', archived: false };
  it('всё в порядке', () => expect(clientHealth(base).level).toBe('healthy'));
  it('просрочка — внимание', () => expect(clientHealth({ ...base, overdueTasks: 1 }).level).toBe('attention'));
  it('тишина 3 недели и застывшая сделка — риск', () => {
    const h = clientHealth({ ...base, daysSinceActivity: 25, dealStalledDays: 18 });
    expect(h.level).toBe('risk');
    expect(h.signals).toEqual(['нет активности 25 дн.', 'сделка не двигалась 18 дн.']);
  });
  it('потерянному и архивному здоровье не считаем', () => {
    expect(clientHealth({ ...base, status: 'lost' }).level).toBeNull();
    expect(clientHealth({ ...base, archived: true }).level).toBeNull();
  });
});

describe('сводка по клиенту — факты с источниками', () => {
  const NOW = new Date('2026-10-07T10:00:00Z');
  it('собирает строки и риски, у каждой — источник', () => {
    const s = clientSummary({
      now: NOW, status: 'active',
      lastActivityAt: '2026-10-05T10:00:00Z', lastActivityTitle: 'встреча «Планёрка»',
      openDeals: [{ id: '88', title: 'Внедрение', amount: 18000, currency: 'EUR', stage: 'proposal', updatedAt: '2026-09-15T10:00:00Z' }],
      openTasks: 2, overdueTasks: [{ id: '1421', title: 'Отправить КП' }],
      nextMeeting: null, nextAction: null,
    });
    expect(s.enough).toBe(true);
    expect(s.lines.map((l) => l.text)).toContain('Последняя активность: 2 дн. назад — встреча «Планёрка».');
    expect(s.lines.find((l) => l.text.startsWith('Открытая сделка'))?.sources).toEqual(['deal:88']);
    expect(s.risks.map((r) => r.text)).toEqual(expect.arrayContaining([
      'Сделка «Внедрение» не меняла стадию 22 дней.',
      'Просрочена задача «Отправить КП».',
      'По клиенту нет следующего действия.',
    ]));
    for (const l of [...s.lines, ...s.risks]) expect(l.sources.length).toBeGreaterThan(0);
  });

  it('данных нет — так и говорим', () => {
    const s = clientSummary({ now: NOW, status: 'lead', lastActivityAt: null, lastActivityTitle: null, openDeals: [], openTasks: 0, overdueTasks: [], nextMeeting: null, nextAction: null });
    expect(s.enough).toBe(false);
  });
});
