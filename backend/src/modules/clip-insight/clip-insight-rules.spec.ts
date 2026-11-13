import {
  bugMarks, bugTaskText, cutAt, isBugPhrase, needsSummary, parseInsight, stamp, summaryFallback, timedText,
} from './clip-insight-rules';

const segs = [
  { start: 0.4, end: 4, text: 'Открываю карточку клиента' },
  { start: 42.2, end: 47, text: 'Вот здесь кнопка Сохранить не работает' },
  { start: 44, end: 48, text: 'и ещё ошибка в консоли' },
  { start: 70, end: 75, text: 'Потом экран зависает' },
];

describe('#4902 п. 14 видео и голос → текст и задачи — правила', () => {
  it('метки времени как в ТЗ: «0:42»', () => {
    expect(stamp(42.9)).toBe('0:42');
    expect(stamp(605)).toBe('10:05');
    expect(stamp(3600)).toBe('1:00:00');
  });

  it('признак бага — по основам, кириллица без \\b', () => {
    expect(isBugPhrase('кнопка не работает')).toBe(true);
    expect(isBugPhrase('Ошибка 500')).toBe(true);
    expect(isBugPhrase('всё зависает')).toBe(true);
    expect(isBugPhrase('всё работает отлично')).toBe(false);
    expect(isBugPhrase('Got an Error here')).toBe(true);
    expect(isBugPhrase('terrorist')).toBe(false);
  });

  it('метки правилами: не чаще одной на 5 секунд', () => {
    expect(bugMarks(segs)).toEqual([
      { sec: 42, label: 'баг', text: 'Вот здесь кнопка Сохранить не работает' },
      { sec: 70, label: 'баг', text: 'Потом экран зависает' },
    ]);
    expect(bugMarks([{ start: 1, end: 2, text: 'всё хорошо' }])).toEqual([]);
  });

  it('кратко правилами — 1–2 предложения до 160 знаков; короткому не нужно', () => {
    expect(summaryFallback('Привет. Нужно сдать отчёт до пятницы. И ещё что-то длинное потом.')).toBe('Привет. Нужно сдать отчёт до пятницы.');
    expect(summaryFallback('слово '.repeat(80)).length).toBeLessThanOrEqual(161);
    expect(summaryFallback('')).toBe('');
    expect(needsSummary('Ок, сделаю')).toBe(false);
    expect(needsSummary('длинно '.repeat(30))).toBe(true);
    expect(cutAt('раз два три', 7)).toBe('раз два…');
  });

  it('ответ модели: кратко ≤ 2 строк, метки на настоящие реплики, без повторов', () => {
    const raw = '```json\n{"summary":"Не сохраняется карточка.\\nВторая строка.\\nТретья","marks":[{"sec":43,"label":"Баг","text":"не работает Сохранить"},{"sec":42,"text":"дубль"},{"sec":"x","text":"нет"},{"sec":71,"label":"шаг","text":"зависание"}]}\n```';
    const out = parseInsight(raw, segs);
    expect(out.summary).toBe('Не сохраняется карточка. Вторая строка.');
    expect(out.marks).toEqual([
      { sec: 42, label: 'баг', text: 'не работает Сохранить' },
      { sec: 70, label: 'шаг', text: 'зависание' },
    ]);
    expect(parseInsight('ничего', segs)).toEqual({ summary: null, marks: [] });
  });

  it('стенограмма для модели — секунды целыми', () => {
    expect(timedText(segs.slice(0, 2))).toBe('[0] Открываю карточку клиента\n[42] Вот здесь кнопка Сохранить не работает');
  });

  it('задача-баг: название из первой метки, описание с метками и расшифровкой', () => {
    const t = bugTaskText({
      summary: 'Не сохраняется карточка клиента', marks: bugMarks(segs), segments: segs, text: '',
      chatTitle: 'Разработка', author: 'Ира', at: new Date('2026-11-13T09:00:00Z'),
    });
    expect(t.title).toBe('Баг: Вот здесь кнопка Сохранить не работает');
    expect(t.description).toContain('в чате «Разработка», автор — Ира, 13.11, 12:00');
    expect(t.description).toContain('Кратко: Не сохраняется карточка клиента');
    expect(t.description).toContain('• 0:42 баг: Вот здесь кнопка Сохранить не работает');
    expect(t.description).toContain('[1:10] Потом экран зависает');
    const bare = bugTaskText({ summary: null, marks: [], segments: [], text: '', chatTitle: null, author: null, at: new Date() });
    expect(bare.title).toBe('Баг: Проблема на записи экрана');
  });
});
