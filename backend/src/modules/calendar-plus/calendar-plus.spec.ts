import { bestTime, chainWith, dayBar, Person, zoneLabel } from './best-time';
import { bufferChanges, candidates, Meeting, weekInsight } from './assistant-rules';
import { durationAnywhere, phraseDraft, pickRepeat, pickTopic } from './phrase-rules';
import { zonedToUtc } from '../calendar/find-time';

const MSK = 'Europe/Moscow';
const at = (d: number, h: number, m = 0, tz = MSK) => zonedToUtc(2026, 11, d, h, m, tz);
const person = (p: Partial<Person> & { id: string }): Person => ({
  name: p.id, timeZone: MSK, workStart: '10:00', workEnd: '19:00', lunchStart: '13:00', lunchEnd: '14:00',
  weekendDays: [0, 6], holidays: [], busy: [], ...p,
});

describe('#4892 п. 4: лучшее время', () => {
  const now = at(16, 9); // понедельник 16.11, 9:00
  it('три слота, лучший помечен, у каждого причина; обед не предлагается', () => {
    const r = bestTime({ now, minutes: 30, viewerTimeZone: MSK, people: [person({ id: 'я', me: true }), person({ id: 'Глеб' })] });
    expect(r.slots).toHaveLength(3);
    expect(r.slots[0].best).toBe(true);
    expect(r.slots.filter((s) => s.best)).toHaveLength(1);
    for (const s of r.slots) {
      expect(s.reasons.length).toBeGreaterThan(0);
      const st = Date.parse(s.startsAt);
      expect(st >= at(16, 13) && st < at(16, 14)).toBe(false);
    }
  });
  it('чужой фокус и встречи не предлагаются; пояс каждого учитывается', () => {
    const gleb = person({ id: 'Глеб', busy: [{ start: at(16, 10), end: at(16, 13), kind: 'focus' }] });
    // Екатеринбург +2: рабочий день 10–19 по Екб = 8–17 по Москве
    const kostya = person({ id: 'Костя', timeZone: 'Asia/Yekaterinburg' });
    const r = bestTime({ now, minutes: 60, viewerTimeZone: MSK, people: [person({ id: 'я', me: true }), gleb, kostya], days: 1 });
    for (const s of r.slots) {
      const st = Date.parse(s.startsAt);
      expect(st >= at(16, 10) && st < at(16, 13)).toBe(false); // фокус Глеба
      expect(Date.parse(s.endsAt) <= at(16, 17)).toBe(true); // конец дня Кости
    }
    expect(zoneLabel('Asia/Yekaterinburg', MSK, now)).toBe('Екб, +2');
  });
  it('последние 30 минут дня — только если других нет', () => {
    const busyAllDay = person({ id: 'Глеб', busy: [{ start: at(16, 10), end: at(16, 18, 30), kind: 'meeting' }] });
    const r = bestTime({ now, minutes: 30, viewerTimeZone: MSK, people: [person({ id: 'я', me: true }), busyAllDay], days: 1, limit: 1 });
    expect(r.slots[0].startsAt).toBe(new Date(at(16, 18, 30)).toISOString());
    expect(r.slots[0].reasons.join(' ')).toContain('последние 30 минут');
  });
  it('третья встреча подряд — штраф и причина', () => {
    const busy = [{ start: at(16, 10), end: at(16, 11), kind: 'meeting' as const }, { start: at(16, 11), end: at(16, 12), kind: 'meeting' as const }];
    expect(chainWith(busy, { start: at(16, 12), end: at(16, 12, 30) })).toBe(3);
  });
  it('необязательный участник не блокирует, но помечен', () => {
    const alina = person({ id: 'Алина', optional: true, busy: [{ start: at(16, 10), end: at(16, 19), kind: 'meeting' }] });
    const r = bestTime({ now, minutes: 30, viewerTimeZone: MSK, people: [person({ id: 'я', me: true }), alina], days: 1 });
    expect(r.slots.length).toBeGreaterThan(0);
    expect(r.slots[0].busyOptional).toEqual(['Алина']);
  });
  it('полоса занятости — без названий, с обедом и фокусом', () => {
    const p = person({ id: 'x', busy: [{ start: at(16, 11), end: at(16, 12), kind: 'focus', title: 'секрет' }] });
    const bar = dayBar(p, at(16, 12), { start: at(16, 10), end: at(16, 19) });
    expect(bar.map((b) => b.kind)).toEqual(['focus', 'lunch']);
    expect(JSON.stringify(bar)).not.toContain('секрет');
  });
});

describe('#4892 п. 1–2: неделя и ассистент', () => {
  const now = at(16, 8);
  const m = (id: string, d: number, h1: number, h2: number, extra: Partial<Meeting> = {}): Meeting => ({
    id, title: id, start: at(d, h1), end: at(d, h2), mine: true, participants: 3, hasAgenda: true, ...extra,
  });
  const base = {
    now, from: at(16, 0), to: at(21, 0), timeZone: MSK,
    work: { workStart: '10:00', workEnd: '19:00', weekendDays: [0, 6], holidays: [] }, lunch: { start: '13:00', end: '14:00' },
    blocks: [], tasks: [],
  };
  it('накладки, подряд без перерыва, окна для фокуса от 2 ч', () => {
    const meetings = [m('a', 19, 15, 16), m('b', 19, 15, 16, { mine: false }), m('c', 18, 14, 15), m('d', 18, 15, 16), m('e', 18, 16, 17)];
    const ins = weekInsight({ ...base, meetings });
    expect(ins.overlaps).toHaveLength(1);
    expect(ins.backToBack).toHaveLength(1);
    expect(ins.meetingMin).toBe(4 * 60);
    expect(ins.focusWindows.every((w) => w.end - w.start >= 120 * 60_000)).toBe(true);
    const c = candidates({ ...base, meetings }, ins);
    expect(c[0].kind).toBe('overlap');
    expect(c[0].meeting?.id).toBe('a'); // переносим свою
    expect(c.some((x) => x.kind === 'buffers')).toBe(true);
  });
  it('буферы — только свои встречи цепочки, кроме последней', () => {
    const ch = bufferChanges([m('c', 18, 14, 15), m('d', 18, 15, 16, { mine: false }), m('e', 18, 16, 17)]);
    expect(ch.map((x) => x.id)).toEqual(['c']);
    expect(ch[0].newEnd).toBe(at(18, 14, 50));
  });
  it('встреча без повестки и окно для задачи со сроком', () => {
    const meetings = [m('crm', 18, 11, 12, { hasAgenda: false })];
    const tasks = [{ id: '7', title: 'Макет', deadline: at(20, 18), estimateMin: 120, planned: false }];
    const c = candidates({ ...base, meetings, tasks }, weekInsight({ ...base, meetings, tasks }));
    expect(c.map((x) => x.kind)).toEqual(['focus_window', 'agenda']);
  });
  it('перегруженный день — больше 5 часов встреч', () => {
    const meetings = [m('1', 17, 10, 12), m('2', 17, 12, 13), m('3', 17, 14, 16), m('4', 17, 16, 17, { participants: 2 })];
    const ins = weekInsight({ ...base, meetings });
    expect(ins.heavyDays).toHaveLength(1);
    expect(candidates({ ...base, meetings }, ins).find((x) => x.kind === 'heavy_day')?.meeting?.id).toBe('4');
  });
});

describe('#4892 п. 3: событие одной фразой — тестовый набор', () => {
  // пятница, 13 ноября 2026, 9:00 — «сейчас» клиента
  const now = new Date(2026, 10, 13, 9, 0);
  const users = [{ id: '1', name: 'Глеб Петров' }, { id: '2', name: 'Константин Ли' }, { id: '3', name: 'Алина Смирнова' }];
  const cases: [string, Partial<{ startsAt: string; endsAt: string; repeat: string | null; people: string[]; title: string }>][] = [
    ['завтра в 15 созвон с Глебом и Константином про CRM, 30 мин', { startsAt: '2026-11-14T15:00', endsAt: '2026-11-14T15:30', people: ['1', '2'], title: 'Созвон: CRM' }],
    ['послезавтра в 11 встреча с Алиной', { startsAt: '2026-11-15T11:00', people: ['3'] }],
    ['в пятницу после обеда демо для клиента', { startsAt: '2026-11-20T14:00' }],
    ['каждый вторник в 10 планёрка', { startsAt: '2026-11-17T10:00', repeat: 'weekly' }],
    ['созвон с Глебом в понедельник в 12 на полчаса', { startsAt: '2026-11-16T12:00', endsAt: '2026-11-16T12:30', people: ['1'] }],
    ['завтра утром синк с командой', { startsAt: '2026-11-14T10:00' }],
    ['сегодня в 16:30 звонок с Константином на 45 минут', { startsAt: '2026-11-13T16:30', endsAt: '2026-11-13T17:15', people: ['2'] }],
    ['по будням в 9:30 стендап на 15 минут', { startsAt: '2026-11-13T09:30', endsAt: '2026-11-13T09:45', repeat: 'weekdays' }],
    ['встреча про бюджет 20 ноября в 14 на час', { startsAt: '2026-11-20T14:00', endsAt: '2026-11-20T15:00', title: 'Встреча: бюджет' }],
    ['в четверг в 3 созвон с Алиной про найм', { startsAt: '2026-11-19T15:00', people: ['3'] }],
  ];
  it('9 из 10 типовых фраз распознаются без правок', () => {
    let ok = 0;
    const misses: string[] = [];
    for (const [text, want] of cases) {
      const d = phraseDraft(text, now, users, { lunchEnd: '14:00' });
      const good = (!want.startsAt || d.startsAt === want.startsAt) && (!want.endsAt || d.endsAt === want.endsAt)
        && (want.repeat === undefined || d.repeat === want.repeat)
        && (!want.people || JSON.stringify([...d.participantIds].sort()) === JSON.stringify(want.people))
        && (!want.title || d.title === want.title);
      if (good) ok++; else misses.push(`${text} → ${JSON.stringify(d)}`);
    }
    if (ok < 10) console.log(misses.join('\n'));
    expect(ok).toBeGreaterThanOrEqual(9);
  });
  it('повтор, длительность и тема', () => {
    expect(pickRepeat('каждый вторник в 10')).toBe('weekly');
    expect(durationAnywhere('созвон, 30 мин')).toBe(30);
    expect(pickTopic('созвон с Глебом про CRM, 30 мин')).toBe('CRM');
  });
});
