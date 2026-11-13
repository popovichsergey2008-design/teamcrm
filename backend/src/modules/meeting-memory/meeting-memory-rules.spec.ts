import {
  bucketOf, countBuckets, cutWords, mergeTracks, MeetingCandidate, parseRecap, pickPrevious, recapFallback,
  sameTopic, samePeople, stamp, topicTokens,
} from './meeting-memory-rules';

const start = new Date('2026-11-13T10:00:00Z');
const cand = (o: Partial<MeetingCandidate>): MeetingCandidate => ({
  id: '1', roomId: null, chatId: null, title: null, participantIds: [], at: new Date('2026-11-10T10:00:00Z'), tasks: 3, ...o,
});
const cur = { roomId: 'room-1', chatId: '7', topic: 'Планёрка по лендингу', participantIds: ['1', '2', '3'], startedAt: start };

describe('#4902 п. 12 память встреч — правила', () => {
  it('слова темы — кириллицей, без чисел и служебных слов', () => {
    expect(topicTokens('Созвон 11.11, 09:22')).toEqual([]);
    expect(topicTokens('Планёрка по лендингу Ёлки')).toEqual(['лендингу', 'елки']);
    expect(sameTopic('Дизайн лендинга: правки', 'Правки дизайна лендинга')).toBe(true);
    expect(sameTopic('Бюджет на рекламу', 'Дизайн лендинга')).toBe(false);
  });

  it('тот же состав — двое общих и не меньше 60 %', () => {
    expect(samePeople(['1', '2', '3'], ['1', '2', '3', '4'])).toBe(true);
    expect(samePeople(['1', '2'], ['1', '5', '6', '7'])).toBe(false);
    expect(samePeople(['1'], ['1'])).toBe(false);
  });

  it('прошлая встреча: комната важнее чата, чат важнее состава; позже начала — нет', () => {
    const list = [
      cand({ id: 'people', participantIds: ['1', '2', '3'], at: new Date('2026-11-12T10:00:00Z') }),
      cand({ id: 'chat', chatId: '7', at: new Date('2026-11-11T10:00:00Z') }),
      cand({ id: 'room', roomId: 'room-1', at: new Date('2026-11-05T10:00:00Z') }),
      cand({ id: 'future', roomId: 'room-1', at: new Date('2026-11-13T11:00:00Z') }),
    ];
    expect(pickPrevious(cur, list)?.meeting.id).toBe('room');
    expect(pickPrevious(cur, list.slice(0, 2))?.meeting.id).toBe('chat');
    expect(pickPrevious(cur, list.slice(0, 1))?.reasons).toEqual(['same_people']);
  });

  it('встреча без задач и чужая встреча — не прошлая', () => {
    expect(pickPrevious(cur, [cand({ roomId: 'room-1', tasks: 0 })])).toBeNull();
    expect(pickPrevious(cur, [cand({ participantIds: ['8', '9'], title: 'Бюджет' })])).toBeNull();
    expect(pickPrevious(cur, [cand({ title: 'Лендингу правки' })])?.reasons).toEqual(['same_topic']);
  });

  it('из равных — самая свежая', () => {
    const a = cand({ id: 'old', chatId: '7', at: new Date('2026-11-01T10:00:00Z') });
    const b = cand({ id: 'new', chatId: '7', at: new Date('2026-11-12T10:00:00Z') });
    expect(pickPrevious(cur, [a, b])?.meeting.id).toBe('new');
  });

  it('этапы задач: готово, на проверке, в работе, не начато', () => {
    expect(bucketOf('done', false)).toBe('done');
    expect(bucketOf('testing', false)).toBe('review');
    expect(bucketOf('approval', true)).toBe('review');
    expect(bucketOf('waiting_external', true)).toBe('review');
    expect(bucketOf('work', true)).toBe('in_progress');
    expect(bucketOf('work', false)).toBe('not_started');
    expect(countBuckets([{ bucket: 'done' }, { bucket: 'done' }, { bucket: 'not_started' }]))
      .toEqual({ done: 2, review: 0, in_progress: 0, not_started: 1, total: 3 });
  });

  it('метки времени', () => {
    expect(stamp(42)).toBe('0:42');
    expect(stamp(725.9)).toBe('12:05');
    expect(stamp(3727)).toBe('1:02:07');
    expect(stamp(-3)).toBe('0:00');
  });

  it('дорожки сшиваются по времени со смещением, повторы отброшены', () => {
    const segs = mergeTracks([
      { speaker: 'Ира', offsetSec: 0, segments: [{ start: 5, text: 'Привет всем' }, { start: 6, text: 'Привет всем' }, { start: 40, text: 'Срок до пятницы' }] },
      { speaker: 'Олег', offsetSec: 30, segments: [{ start: 2, text: 'Я опоздал' }] },
    ]);
    expect(segs.map((s) => [s.sec, s.speaker])).toEqual([[5, 'Ира'], [32, 'Олег'], [40, 'Ира']]);
  });

  it('пересказ правилами: не больше пяти пунктов, весомое, по всему звонку', () => {
    const segs = Array.from({ length: 30 }, (_, i) => ({
      sec: i * 60, speaker: i % 2 ? 'Ира' : 'Олег',
      text: i === 3 ? 'Решили перенести релиз на пятницу и предупредить клиента' : `обычная реплика номер ${i} про всякое разное`,
    }));
    const pts = recapFallback(segs);
    expect(pts.length).toBe(5);
    expect(pts.some((p) => p.sec === 180)).toBe(true);
    expect(pts[pts.length - 1].sec).toBeGreaterThan(1200);
    expect(pts.every((p, i) => i === 0 || p.sec > pts[i - 1].sec)).toBe(true);
    expect(recapFallback([{ sec: 1, speaker: 'А', text: 'да' }])).toEqual([]);
  });

  it('ответ модели: метки — только настоящих реплик, лишнее отрезано', () => {
    const segs = [{ sec: 10, speaker: 'Ира', text: 'a b c d' }, { sec: 95, speaker: 'Олег', text: 'e f g h' }];
    const raw = 'Вот: {"points":[{"sec":90,"text":"Олег берёт отчёт"},{"sec":12,"speaker":"Ира","text":"Срок — пятница"},{"sec":"x","text":""}]}';
    expect(parseRecap(raw, segs)).toEqual([
      { sec: 10, speaker: 'Ира', text: 'Срок — пятница' },
      { sec: 95, speaker: 'Олег', text: 'Олег берёт отчёт' },
    ]);
    expect(parseRecap('не json', segs)).toEqual([]);
    expect(cutWords('раз два три четыре', 2)).toBe('раз два…');
  });
});
