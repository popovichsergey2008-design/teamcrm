import { buildEventDraft, cleanTitle, matchPeople, parseLocalInput, toLocalInput } from './event-draft';

const users = [
  { id: '1', name: 'Пётр Иванов' },
  { id: '2', name: 'Ольга Ким' },
  { id: '3', name: 'Сергей Попович' },
];

// среда, 26 августа 2026, 11:00 по местному времени
const now = new Date(2026, 7, 26, 11, 0);
const draft = (text: string, at = now) => buildEventDraft(text, at, users);

describe('Надиктованная встреча — разбор', () => {
  it('«завтра в 15 на час» превращается в дату, время и длительность', () => {
    const d = draft('созвон с подрядчиком завтра в 15 на час');
    expect(d.startsAt).toBe('2026-08-27T15:00');
    expect(d.endsAt).toBe('2026-08-27T16:00');
    expect(d.allDay).toBe(false);
  });

  it('без длительности встреча идёт час', () => {
    expect(draft('планёрка сегодня в 9 утра').endsAt).toBe('2026-08-26T10:00');
  });

  it('«в 3» — это рабочие 15:00, а не ночь', () => {
    expect(draft('встреча завтра в 3').startsAt).toBe('2026-08-27T15:00');
    expect(draft('встреча завтра в 3 ночи').startsAt).toBe('2026-08-27T03:00');
  });

  it('названное время уже прошло — значит речь о завтра', () => {
    // 9 утра при текущем времени 11:00
    expect(draft('созвон в 9 утра').startsAt).toBe('2026-08-27T09:00');
  });

  it('день назвали, час — нет: начало рабочего дня', () => {
    expect(draft('встреча с Ольгой в пятницу').startsAt).toBe('2026-08-28T10:00');
  });

  it('«весь день» занимает сутки целиком', () => {
    const d = draft('выезд на объект завтра весь день');
    expect(d.allDay).toBe(true);
    expect(d.startsAt).toBe('2026-08-27T00:00');
    expect(d.endsAt).toBe('2026-08-27T23:59');
  });

  it('длительность словами и цифрами', () => {
    expect(draft('созвон завтра в 10 на полтора часа').endsAt).toBe('2026-08-27T11:30');
    expect(draft('созвон завтра в 10 на полчаса').endsAt).toBe('2026-08-27T10:30');
    expect(draft('созвон завтра в 10 на 20 минут').endsAt).toBe('2026-08-27T10:20');
    expect(draft('созвон завтра в 10 на 2 часа').endsAt).toBe('2026-08-27T12:00');
  });

  it('дата числом и месяцем', () => {
    expect(draft('сдача проекта 15 сентября в 12').startsAt).toBe('2026-09-15T12:00');
    expect(draft('сдача проекта 15.09 в 12').startsAt).toBe('2026-09-15T12:00');
    // названная дата уже прошла — значит следующий год
    expect(draft('корпоратив 10 января в 18').startsAt).toBe('2027-01-10T18:00');
  });

  it('без единого признака времени даты не выдумываются', () => {
    const d = draft('обсудить смету с Ольгой');
    expect(d.startsAt).toBeNull();
    expect(d.endsAt).toBeNull();
  });

  it('участники узнаются по имени и по фамилии, в любом падеже', () => {
    expect(matchPeople('созвон с Петром и Ольгой', users).ids.sort()).toEqual(['1', '2']);
    expect(matchPeople('встреча с Ивановым', users).ids).toEqual(['1']);
    expect(matchPeople('позвать Поповича', users).ids).toEqual(['3']);
    expect(matchPeople('встреча с подрядчиком', users).ids).toEqual([]);
  });

  it('название очищается от команды и от того, что стало полями', () => {
    expect(cleanTitle('поставь встречу обсуждение сметы завтра в 15 на час')).toBe('обсуждение сметы');
    expect(cleanTitle('созвон с подрядчиком')).toBe('созвон с подрядчиком');
    // если после чистки не осталось ничего — берём как сказали
    expect(cleanTitle('завтра в 15')).toBe('завтра в 15');
  });

  it('место распознаётся, ссылка и созвон местом не считаются', () => {
    expect(draft('встреча завтра в 12 в переговорной').location).toBe('в переговорной');
    expect(draft('созвон с Ольгой завтра в 12').location).toBeNull();
  });

  it('модель уточняет название и место, но время остаётся за правилами', () => {
    const d = buildEventDraft('созвон завтра в 15', now, users, {
      title: 'Созвон по смете', location: 'Zoom', allDay: false,
    });
    expect(d.title).toBe('Созвон по смете');
    expect(d.location).toBe('Zoom');
    expect(d.startsAt).toBe('2026-08-27T15:00');
  });

  it('формат времени тот же, что понимает поле формы', () => {
    const d = new Date(2026, 0, 3, 9, 5);
    expect(toLocalInput(d)).toBe('2026-01-03T09:05');
    expect(parseLocalInput('2026-01-03T09:05')?.getTime()).toBe(d.getTime());
    expect(parseLocalInput('мусор')).toBeNull();
  });
});
