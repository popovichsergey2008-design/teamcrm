import { meetingLead, minuteWord, participantOf, periodOf, playLabel, shapeAnswer, spokenDate } from './answer-rules';

const TZ = 'Europe/Moscow';
const now = new Date('2026-10-22T09:00:00Z'); // чт 22.10.2026, 12:00 МСК
const iso = (d: Date) => d.toISOString();

describe('второй мозг: период из вопроса (#1525)', () => {
  it('«в августе» — август этого года по Москве', () => {
    const p = periodOf('Что мы решили по комиссии банка в августе?', now, TZ)!;
    expect(iso(p.from)).toBe('2026-07-31T21:00:00.000Z');
    expect(iso(p.to)).toBe('2026-08-31T21:00:00.000Z');
    expect(p.label).toBe('август');
  });

  it('месяц позже текущего — прошлый год; год словами — он', () => {
    expect(iso(periodOf('что решили в декабре', now, TZ)!.from)).toBe('2025-11-30T21:00:00.000Z');
    expect(iso(periodOf('что было в мае 2024', now, TZ)!.from)).toBe('2024-04-30T21:00:00.000Z');
    expect(periodOf('итоги за сентябрь', now, TZ)!.label).toBe('сентябрь');
  });

  it('«14 августа» — один день', () => {
    const p = periodOf('о чём договорились 14 августа?', now, TZ)!;
    expect(iso(p.from)).toBe('2026-08-13T21:00:00.000Z');
    expect(iso(p.to)).toBe('2026-08-14T21:00:00.000Z');
  });

  it('прошлый месяц, прошлая неделя, вчера', () => {
    expect(iso(periodOf('что решили в прошлом месяце', now, TZ)!.from)).toBe('2026-08-31T21:00:00.000Z');
    const w = periodOf('кто что обещал на прошлой неделе', now, TZ)!;
    expect(iso(w.from)).toBe('2026-10-11T21:00:00.000Z'); // пн 12.10
    expect(iso(w.to)).toBe('2026-10-18T21:00:00.000Z');
    expect(iso(periodOf('что было вчера', now, TZ)!.from)).toBe('2026-10-20T21:00:00.000Z');
  });

  it('без периода — null; «мае» внутри слова не месяц', () => {
    expect(periodOf('что решили по комиссии банка?', now, TZ)).toBeNull();
    expect(periodOf('как мы управляем рисками', now, TZ)).toBeNull();
  });
});

describe('второй мозг: подпись и ссылка', () => {
  it('подпись фрагмента созвона по документу', () => {
    const at = new Date('2026-08-14T11:12:15Z');
    expect(meetingLead(at, 735, 'Константин Иванов', now, TZ)).toBe('14 августа на 12-й минуте созвона с Константином');
    expect(playLabel(735)).toBe('Вот ссылка на созвон с воспроизведением с 12:15');
    expect(minuteWord(20)).toBe('на 1-й минуте');
    expect(spokenDate(new Date('2025-08-14T10:00:00Z'), now, TZ)).toBe('14 августа 2025');
  });

  it('участник — кто говорил, кроме спрашивающего и «Спикер 1»', () => {
    const snip = '[12:15] Сергей Попович: давайте решим\n[12:20] Константин: закладываем 2.5%';
    expect(participantOf(snip, null, 'Сергей Попович')).toBe('Константин');
    expect(participantOf('[0:10] Спикер 1: привет', null, 'Анна')).toBeNull();
    expect(participantOf(snip, 'Глеб', 'Сергей')).toBe('Глеб');
  });

  it('ответ формой документа: без [n], ссылка — из процитированного созвона', () => {
    const sources = [
      { sourceType: 'task', link: '/projects/1/task/2', sec: null },
      { sourceType: 'meeting', link: '/meetings/7?t=735', sec: 735 },
    ];
    const r = shapeAnswer('14 августа на 12-й минуте созвона с Константином решено: заложить комиссию 2.5 процента в договор [2]. Вот ссылка на запись с 12:15.', sources);
    expect(r.text).toBe('14 августа на 12-й минуте созвона с Константином решено: заложить комиссию 2.5 процента в договор.');
    expect(r.play).toEqual({ link: '/meetings/7?t=735', label: 'Вот ссылка на созвон с воспроизведением с 12:15' });
    expect(shapeAnswer('По регламенту [1].', sources)).toEqual({ text: 'По регламенту.', play: null });
  });
});
