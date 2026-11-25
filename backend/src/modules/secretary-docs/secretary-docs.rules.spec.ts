import {
  advanceReportRows, contractRules, docCardText, docReminder, greetingTemplate, markReminded, mergeRisks, nextOccurrence,
  normDate, occasion, parseContractAi, parseReceiptAi,
} from './secretary-docs.rules';

const doc = (expires_on: string, reminded: number[] = [], remind_days = [30, 7, 1]) => ({ expires_on, remind_days, reminded, renewed_at: null });

describe('#1476 F20: когда напоминать о сроке документа', () => {
  it('за 30 дней — первый порог', () => {
    expect(docReminder(doc('2026-12-25'), '2026-11-25')).toBe(30);
  });
  it('раньше порога — молчим', () => {
    expect(docReminder(doc('2027-03-01'), '2026-11-25')).toBeNull();
  });
  it('порог срабатывает один раз', () => {
    expect(docReminder(doc('2026-12-24', [30]), '2026-11-25')).toBeNull();
  });
  it('добавили за 5 дней — сразу ближайший порог 7, пропущенный 30 не догоняем', () => {
    expect(docReminder(doc('2026-11-30'), '2026-11-25')).toBe(7);
    expect(markReminded({ remind_days: [30, 7, 1], reminded: [] }, 7)).toEqual([7, 30]);
  });
  it('после 7 — порог 1 накануне', () => {
    expect(docReminder(doc('2026-11-26', [7, 30]), '2026-11-25')).toBe(1);
  });
  it('в день окончания и после — по одному разу', () => {
    expect(docReminder(doc('2026-11-25', [1, 7, 30]), '2026-11-25')).toBe(0);
    expect(docReminder(doc('2026-11-20', [0, 1, 7, 30]), '2026-11-25')).toBe(-1);
    expect(docReminder(doc('2026-11-20', [-1, 0]), '2026-11-25')).toBeNull();
  });
  it('продлённый документ не напоминает', () => {
    expect(docReminder({ ...doc('2026-11-26'), renewed_at: new Date() }, '2026-11-25')).toBeNull();
  });
  it('текст карточки со склонением', () => {
    expect(docCardText({ title: 'Загранпаспорт', kind: 'passport', expires_on: '2026-12-25' }, 30, '2026-11-25').title).toBe('Через 30 дней заканчивается: Загранпаспорт');
    expect(docCardText({ title: '', kind: 'visa', expires_on: '2026-11-26' }, 1, '2026-11-25').title).toBe('Через 1 день заканчивается: Виза');
    expect(docCardText({ title: 'ОСАГО', kind: 'insurance', expires_on: '2026-11-20' }, -1, '2026-11-25').priority).toBe(0);
    // порог 7, а до срока 3 дня — в заголовке настоящий остаток
    expect(docCardText({ title: 'Шенген', kind: 'visa', expires_on: '2026-11-28' }, 7, '2026-11-25').title).toBe('Через 3 дня заканчивается: Шенген');
  });
});

describe('#1476 F11: даты клиентов', () => {
  it('ближайшая дата — в этом году или в следующем', () => {
    expect(nextOccurrence(11, 26, '2026-11-25')).toMatchObject({ days: 1, year: 2026 });
    expect(nextOccurrence(1, 10, '2026-11-25')).toMatchObject({ year: 2027, iso: '2027-01-10' });
    expect(nextOccurrence(11, 25, '2026-11-25').days).toBe(0);
  });
  it('29 февраля в невисокосный год — 28-го', () => {
    expect(nextOccurrence(2, 29, '2027-02-27')).toMatchObject({ iso: '2027-02-28', days: 1 });
  });
  it('повод и черновик без модели', () => {
    const s = { kind: 'partnership', title: null, person: 'Иван Петров', client: 'Ромашка', years: 5 };
    expect(occasion(s)).toBe('5 лет сотрудничества с «Ромашка»');
    expect(greetingTemplate(s)).toContain('Иван, добрый день!');
    expect(greetingTemplate({ ...s, kind: 'birthday' })).toContain('с днём рождения');
  });
});

describe('#1476 F21: проверка договора', () => {
  const text = 'Договор оказания услуг. Исполнитель вправе в одностороннем порядке изменить стоимость услуг. '
    + 'За просрочку оплаты Заказчик уплачивает неустойку 1% в день. Договор автоматически продлевается на год. '
    + 'Акт считается подписанным, если Заказчик не направил возражения в течение 2 дней.';
  it('правила находят типовые риски с цитатой', () => {
    const r = contractRules(text);
    const topics = r.map((x) => x.topic);
    expect(topics).toEqual(expect.arrayContaining(['Одностороннее изменение или отказ', 'Неустойка и штрафы', 'Автоматическое продление', 'Молчаливая приёмка']));
    expect(r.find((x) => x.topic.startsWith('Одностороннее'))!.quote).toContain('в одностороннем порядке изменить стоимость');
  });
  it('ответ модели в ``` разбирается, мусор — null', () => {
    const raw = '```json\n{"summary":"Услуги","parties":["ООО А","ИП Б"],"risks":[{"level":"high","topic":"Неустойка","quote":"1% в день","why":"много","fix":"0,1%"}],"missing":["срок оплаты"]}\n```';
    const p = parseContractAi(raw)!;
    expect(p.parties).toEqual(['ООО А', 'ИП Б']);
    expect(p.risks[0]).toMatchObject({ level: 'high', source: 'ai' });
    expect(parseContractAi('не знаю')).toBeNull();
  });
  it('тема, которую назвала модель, из правил не дублируется; высокие риски первыми', () => {
    const ai = [{ level: 'medium' as const, topic: 'Неустойка 1% в день', quote: '', why: 'высокая', fix: '', source: 'ai' as const }];
    const merged = mergeRisks(ai, contractRules(text));
    expect(merged.filter((r) => /неустойк/i.test(r.topic))).toHaveLength(1);
    expect(merged[0].level).toBe('high');
  });
});

describe('#1476 F24: чеки', () => {
  it('поля чека из ответа модели', () => {
    const r = parseReceiptAi('{"date":"21.11.2026","seller":"ООО Такси","inn":"7701234567","total":"1 250,50","vat":"208,42","currency":"rub","category":"taxi"}', '2026-11-25')!;
    expect(r).toMatchObject({ spentOn: '2026-11-21', total: 1250.5, vat: 208.42, sellerInn: '7701234567', currency: 'RUB', category: 'taxi' });
  });
  it('без суммы — не распознан; дата из будущего отбрасывается', () => {
    expect(parseReceiptAi('{"seller":"x"}', '2026-11-25')).toBeNull();
    expect(normDate('2027-05-01', '2026-11-25')).toBeNull();
    expect(normDate('25.11.26', '2026-11-25')).toBe('2026-11-25');
  });
  it('отчёт: строки по дате и итог по категориям', () => {
    const rows = advanceReportRows([
      { spent_on: '2026-11-21', seller: 'Такси', seller_inn: null, total: '500.00', vat: null, currency: 'RUB', category: 'taxi', purpose: 'встреча' },
      { spent_on: '2026-11-20', seller: 'Отель', seller_inn: null, total: 3000, vat: '500', currency: 'RUB', category: 'hotel', purpose: null },
    ], { person: 'Сергей', from: '2026-11-01', to: '2026-11-30' });
    expect(rows[5][2]).toBe('Отель');
    expect(rows.find((r) => r[4] === 'ВСЕГО')![6]).toBe('3500,00');
  });
});
