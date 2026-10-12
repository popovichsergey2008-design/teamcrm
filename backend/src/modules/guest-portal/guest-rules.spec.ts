import {
  contrastWithWhite, draftAgreements, googleCalendarUrl, guestLanguage, parseModelDraft, postcallState, rulesSummary, safeAccent,
} from './guest-rules';

describe('бренд', () => {
  it('светлый фирменный цвет затемняется до читаемого белого текста (AA)', () => {
    const a = safeAccent('#ffd400')!;
    expect(contrastWithWhite(a)).toBeGreaterThanOrEqual(4.5);
    expect(safeAccent('#1f3a93')).toBe('#1f3a93'); // уже тёмный — без изменений
    expect(safeAccent('красный')).toBeNull();
  });
  it('язык гостя: из браузера, неизвестный — русский', () => {
    expect(guestLanguage('en-US')).toBe('en');
    expect(guestLanguage(undefined)).toBe('ru');
  });
});

describe('черновик договорённостей', () => {
  it('решения — общие, поручения — наша сторона, отклонённое и повторы — нет', () => {
    const a = draftAgreements(
      [{ id: '1', text: 'Утвердили дизайн первой версии.' }],
      [
        { id: '7', title: 'Обновить макеты', deadlineAt: '2026-10-15T09:00:00Z', status: 'applied', assigneeId: '3' },
        { id: '8', title: 'Лишнее', deadlineAt: null, status: 'rejected', assigneeId: '3' },
        { id: '9', title: 'утвердили дизайн первой версии', deadlineAt: null, status: 'pending', assigneeId: null },
        { id: '10', title: 'Прислать тексты', deadlineAt: null, status: 'pending', assigneeId: null },
      ],
    );
    expect(a.map((x) => [x.text, x.side])).toEqual([
      ['Утвердили дизайн первой версии.', 'both'],
      ['Обновить макеты', 'ours'],
      ['Прислать тексты', 'unassigned'],
    ]);
    expect(a[1].deadlineAt).toBe('2026-10-15T09:00:00.000Z');
  });
  it('без модели — вежливый текст на языке клиента', () => {
    expect(rulesSummary('Прототип', [{ text: 'x' }], 'ru')).toContain('договорённости');
    expect(rulesSummary('Prototype', [], 'en')).toBe('Thank you for the meeting "Prototype".');
  });
});

describe('ответ модели', () => {
  const orig = ['Агентство обновляет макеты до 15.10', 'Клиент присылает тексты до 14.10'];
  it('перевод принимается, если числа в каждой договорённости те же', () => {
    const r = parseModelDraft('{"summary":"We approved the design.","agreements":["Agency updates mockups by 15.10","Client sends texts by 14.10"]}', orig);
    expect(r?.summary).toBe('We approved the design.');
    expect(r?.agreements?.[0]).toContain('15.10');
  });
  it('поплывшая дата — перевод договорённостей отбрасывается, текст остаётся', () => {
    const r = parseModelDraft('Вот: {"summary":"Итоги.","agreements":["Макеты до 16.10","Тексты до 14.10"]}', orig);
    expect(r?.summary).toBe('Итоги.');
    expect(r?.agreements).toBeNull();
  });
  it('не JSON — ничего', () => {
    expect(parseModelDraft('просто текст', orig)).toBeNull();
  });
});

describe('экран после встречи', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  it('опубликовано — готово, срок показа вышел — истекло', () => {
    expect(postcallState({ publishedAt: new Date('2026-10-11T12:00:00Z'), summaryDays: 30, meetingHappened: true, now })).toBe('ready');
    expect(postcallState({ publishedAt: new Date('2026-09-01T12:00:00Z'), summaryDays: 30, meetingHappened: true, now })).toBe('expired');
  });
  it('встреча была, протокола нет — «готовим», встречи не было — ничего', () => {
    expect(postcallState({ publishedAt: null, summaryDays: 30, meetingHappened: true, now })).toBe('processing');
    expect(postcallState({ publishedAt: null, summaryDays: 30, meetingHappened: false, now })).toBe('none');
  });
  it('ссылка «добавить в Google Календарь»', () => {
    const u = googleCalendarUrl({ title: 'Ревью', startsAt: new Date('2026-10-16T11:00:00Z'), endsAt: new Date('2026-10-16T12:00:00Z') });
    expect(u).toContain('dates=20261016T110000Z%2F20261016T120000Z');
  });
});
