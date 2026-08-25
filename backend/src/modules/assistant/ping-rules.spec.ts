import { dedupKey, humanHours, localParts, PingCandidate, pingText, withinWorkHours, WorkHours } from './ping-rules';

const work: WorkHours = {
  workStart: '09:00',
  workEnd: '18:00',
  weekendDays: [0, 6],
  holidays: ['2026-01-01'],
};

// среда, 2026-08-26, 12:00 UTC
const noonUtc = new Date('2026-08-26T12:00:00Z');

const candidate = (p: Partial<PingCandidate> = {}): PingCandidate => ({
  kind: 'overdue', userId: '1', taskId: '10',
  title: 'Договор с подрядчиком', projectName: 'Стройка', hours: 30, timezone: 'Europe/Moscow', ...p,
});

describe('Смарт-пинги — правила', () => {
  it('местное время считается по поясу получателя, а не сервера', () => {
    expect(localParts(noonUtc, 'Europe/Moscow').hour).toBe(15);
    expect(localParts(noonUtc, 'Asia/Novosibirsk').hour).toBe(19);
    expect(localParts(noonUtc, 'Europe/Moscow').dow).toBe(3); // среда
  });

  it('неизвестный пояс не заставляет молчать — считаем по московскому', () => {
    expect(localParts(noonUtc, 'Marsia/Olympus').hour).toBe(15);
    expect(localParts(noonUtc, null).hour).toBe(15);
  });

  it('в рабочие часы пишем, ночью и в выходной — нет', () => {
    expect(withinWorkHours(noonUtc, 'Europe/Moscow', work)).toBe(true);
    // 03:00 по Москве
    expect(withinWorkHours(new Date('2026-08-26T00:00:00Z'), 'Europe/Moscow', work)).toBe(false);
    // тот же момент в Новосибирске — уже 07:00, до начала дня
    expect(withinWorkHours(new Date('2026-08-26T00:00:00Z'), 'Asia/Novosibirsk', work)).toBe(false);
    // суббота
    expect(withinWorkHours(new Date('2026-08-29T09:00:00Z'), 'Europe/Moscow', work)).toBe(false);
  });

  it('праздник — не рабочий день, даже если это будни', () => {
    // 1 января 2026 — четверг
    expect(withinWorkHours(new Date('2026-01-01T09:00:00Z'), 'Europe/Moscow', work)).toBe(false);
  });

  it('конец рабочего дня — граница закрытая: в 18:00 уже не пишем', () => {
    expect(withinWorkHours(new Date('2026-08-26T14:59:00Z'), 'Europe/Moscow', work)).toBe(true); // 17:59
    expect(withinWorkHours(new Date('2026-08-26T15:00:00Z'), 'Europe/Moscow', work)).toBe(false); // 18:00
  });

  it('половинки часа тоже считаются: день с 9:30 до 17:45', () => {
    const half = { ...work, workStart: '09:30', workEnd: '17:45' };
    expect(withinWorkHours(new Date('2026-08-26T06:15:00Z'), 'Europe/Moscow', half)).toBe(false); // 09:15
    expect(withinWorkHours(new Date('2026-08-26T06:45:00Z'), 'Europe/Moscow', half)).toBe(true); // 09:45
    expect(withinWorkHours(new Date('2026-08-26T14:50:00Z'), 'Europe/Moscow', half)).toBe(false); // 17:50
  });

  it('часы превращаются в человеческие сроки', () => {
    expect(humanHours(5)).toBe('5 ч');
    expect(humanHours(24)).toBe('1 день');
    expect(humanHours(50)).toBe('2 дня');
    expect(humanHours(130)).toBe('5 дней');
    expect(humanHours(264)).toBe('11 дней'); // «одиннадцать», а не «один»
  });

  it('текст называет задачу и говорит фактом', () => {
    expect(pingText(candidate())).toBe('Срок прошёл 1 день назад: «Договор с подрядчиком» (Стройка)');
    expect(pingText(candidate({ kind: 'due_soon', hours: 5 }))).toContain('Срок через 5 ч');
    expect(pingText(candidate({ kind: 'stuck_review', hours: 72 }))).toContain('Ждёт вашей проверки 3 дня');
    expect(pingText(candidate({ kind: 'silent', hours: 120 }))).toContain('Что со статусом?');
    // проект не назван — предложение всё равно остаётся целым
    expect(pingText(candidate({ projectName: null }))).toBe('Срок прошёл 1 день назад: «Договор с подрядчиком»');
  });

  it('ключ повтора держит один повод в сутки и различает поводы', () => {
    expect(dedupKey(candidate(), noonUtc)).toBe('overdue:10:2026-08-26');
    expect(dedupKey(candidate({ kind: 'silent' }), noonUtc)).toBe('silent:10:2026-08-26');
    // 23:30 по Москве и 00:30 следующего дня в Новосибирске — разные сутки у разных людей
    const late = new Date('2026-08-26T20:30:00Z');
    expect(dedupKey(candidate(), late)).toBe('overdue:10:2026-08-26');
    expect(dedupKey(candidate({ timezone: 'Asia/Novosibirsk' }), late)).toBe('overdue:10:2026-08-27');
  });
});
