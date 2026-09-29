import {
  dayLabel, durationOf, MEETING_MAX_PEOPLE, meetingAskText, meetingDateOf, meetingParticipants,
  meetingReadiness, parseTimeAnswer,
} from './meeting-rules';

const now = new Date('2026-09-29T09:00:00.000Z');

describe('meetingReadiness', () => {
  const base = { intent: 0.95, meetingAt: new Date('2026-09-30T12:00:00.000Z'), meetingDate: null, participants: ['1', '2'], cancelled: false, now };

  it('дата, время и двое участников — готово', () => {
    expect(meetingReadiness(base)).toBe('ready');
  });
  it('только дата — спросить время', () => {
    expect(meetingReadiness({ ...base, meetingAt: null, meetingDate: '2026-09-30' })).toBe('needs_clarification');
  });
  it('ни даты, ни времени — это намерение, а не договорённость', () => {
    expect(meetingReadiness({ ...base, meetingAt: null })).toBe('detected');
  });
  it('время уже прошло — не готово', () => {
    expect(meetingReadiness({ ...base, meetingAt: new Date('2026-09-29T08:00:00.000Z') })).toBe('detected');
  });
  it('один участник — это не созвон', () => {
    expect(meetingReadiness({ ...base, participants: ['1'] })).toBe('detected');
  });
  it('отменили в разговоре или не уверен — не готово', () => {
    expect(meetingReadiness({ ...base, cancelled: true })).toBe('detected');
    expect(meetingReadiness({ ...base, intent: 0.7 })).toBe('detected');
  });
});

describe('meetingParticipants', () => {
  it('организатор первым, без повторов и без бота', () => {
    expect(meetingParticipants({ organizerId: '1', named: ['3', '1'], authors: ['2', null, '3'] })).toEqual(['1', '3', '2']);
  });
  it('больше потолка не зовём, организатора не отсекаем', () => {
    const many = Array.from({ length: 30 }, (_, i) => String(i + 10));
    const r = meetingParticipants({ organizerId: '1', named: many, authors: [] });
    expect(r).toHaveLength(MEETING_MAX_PEOPLE);
    expect(r[0]).toBe('1');
  });
});

describe('parseTimeAnswer', () => {
  it.each([
    ['14:00', '14:00'],
    ['давай в 15', '15:00'],
    ['к 9.30', '09:30'],
    ['в 3 дня', '15:00'],
    ['в 10 утра', '10:00'],
    ['в 16 часов', '16:00'],
    ['Давайте в 11:15, мне удобно', '11:15'],
  ])('«%s» → %s', (text, time) => {
    expect(parseTimeAnswer(text)).toBe(time);
  });

  it.each([
    ['30'],
    ['30 сентября'],
    ['в 14 или в 16'],
    ['не знаю пока'],
    ['25:00'],
  ])('«%s» — времени нет или оно неоднозначно', (text) => {
    expect(parseTimeAnswer(text)).toBeNull();
  });
});

describe('мелочи', () => {
  it('длительность в границах, мусор — полчаса', () => {
    expect(durationOf(60)).toBe(60);
    expect(durationOf(5)).toBe(15);
    expect(durationOf(900)).toBe(240);
    expect(durationOf('час')).toBe(30);
  });
  it('дата встречи не в прошлом', () => {
    expect(meetingDateOf('2026-09-30', '2026-09-29')).toBe('2026-09-30');
    expect(meetingDateOf('2026-09-28', '2026-09-29')).toBeNull();
    expect(meetingDateOf('завтра', '2026-09-29')).toBeNull();
  });
  it('вопрос называет дату словами и даёт пример ответа', () => {
    expect(dayLabel('2026-09-30')).toBe('30 сентября');
    const t = meetingAskText({ who: 'Ольга', title: 'интеграция', date: '2026-09-30' });
    expect(t).toContain('Ольга, во сколько поставить встречу «интеграция» на 30 сентября?');
    expect(t).toContain('«14:00»');
  });
});
