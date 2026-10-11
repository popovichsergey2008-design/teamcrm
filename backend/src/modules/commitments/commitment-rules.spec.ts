import { detectCommitment, looksCancelled, looksFulfilled, parseDeadline, similarity } from './commitment-rules';

const MON = { date: '2026-10-12', hour: 11, minute: 0, isoDow: 1 };

describe('обещания: распознавание', () => {
  it('«Я отправлю смету сегодня» — обещание со сроком', () => {
    const d = detectCommitment('Я отправлю смету сегодня', MON);
    expect(d?.action).toBe('отправлю смету сегодня');
    expect(d?.deadline).toEqual({ kind: 'local', date: '2026-10-12', time: '18:00', text: 'сегодня' });
    expect(d!.confidence).toBeGreaterThanOrEqual(0.85);
  });
  it('«Проверю завтра», «Сделаю до пятницы», «Беру»', () => {
    expect(detectCommitment('Ок, проверю завтра', MON)?.deadline).toMatchObject({ date: '2026-10-13' });
    expect(detectCommitment('Сделаю до пятницы', MON)?.deadline).toMatchObject({ date: '2026-10-16' });
    expect(detectCommitment('Беру на себя договор с банком', MON)?.action).toContain('договор с банком');
  });
  it('не обещание: вопрос, условие, отрицание, «попробую», цитата', () => {
    expect(detectCommitment('Пришлю смету сегодня?', MON)).toBeNull();
    expect(detectCommitment('Если успею, пришлю смету', MON)).toBeNull();
    expect(detectCommitment('Не сделаю до пятницы, извини', MON)).toBeNull();
    expect(detectCommitment('Попробую прислать завтра', MON)).toBeNull();
    expect(detectCommitment('> я пришлю смету сегодня\nспасибо', MON)).toBeNull();
    expect(detectCommitment('Он пришлёт смету', MON)).toBeNull();
  });
  it('срок: время, «через 2 дня», дата', () => {
    expect(parseDeadline('пришлю к 15:30', MON)).toEqual({ kind: 'local', date: '2026-10-12', time: '15:30', text: 'к 15:30' });
    expect(parseDeadline('пришлю к 9:00', MON)).toMatchObject({ date: '2026-10-13' }); // уже прошло — завтра
    expect(parseDeadline('сделаю через 2 дня', MON)).toEqual({ kind: 'relative', minutes: 2880, text: 'через 2 дня' });
    expect(parseDeadline('сдам до 15.10', MON)).toMatchObject({ date: '2026-10-15' });
    expect(parseDeadline('пришлю 3 ноября', MON)).toMatchObject({ date: '2026-11-03' });
    expect(parseDeadline('пришлю', MON)).toBeNull();
  });
});

describe('обещания: выполнение и отмена', () => {
  it('файл, ссылка, «отправил», «готово»', () => {
    expect(looksFulfilled({ body: '', hasFile: true })).toBe(true);
    expect(looksFulfilled({ body: 'держи https://docs.example.com/x', hasFile: false })).toBe(true);
    expect(looksFulfilled({ body: 'Отправил на почту', hasFile: false })).toBe(true);
    expect(looksFulfilled({ body: 'завтра посмотрю', hasFile: false })).toBe(false);
  });
  it('отмена', () => {
    expect(looksCancelled('Уже не нужно, спасибо')).toBe(true);
    expect(looksCancelled('нужно до пятницы')).toBe(false);
  });
  it('похожесть действия и задачи', () => {
    expect(similarity('отправлю смету для банка', 'Смета для банка')).toBeGreaterThanOrEqual(0.5);
    expect(similarity('проверю договор', 'Верстка лендинга')).toBe(0);
  });
});
