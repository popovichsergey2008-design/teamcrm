import { closedSegments, MAX_SEGMENT_MESSAGES, SegmentMessage } from './segments';

const QUIET = 20 * 60_000;
const t0 = new Date('2026-09-29T09:00:00.000Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

const msg = (id: number, min: number, over: Partial<SegmentMessage> = {}): SegmentMessage => ({
  id: String(id), createdAt: at(min), authorId: '7', isAi: false, ...over,
});

describe('затихший разговор', () => {
  it('один разговор с паузами короче тишины — один отрезок', () => {
    const now = at(40);
    const s = closedSegments([msg(1, 0), msg(2, 3), msg(3, 12)], QUIET, now);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ startId: '1', endId: '3', count: 3 });
  });

  it('длинная пауза внутри переписки делит её на два разговора', () => {
    const now = at(200);
    const s = closedSegments([msg(1, 0), msg(2, 5), msg(3, 90), msg(4, 95)], QUIET, now);
    expect(s.map((x) => [x.startId, x.endId])).toEqual([['1', '2'], ['3', '4']]);
  });

  it('живой разговор не отдаём: итог ещё не сложился', () => {
    // Переписка идёт прямо сейчас — последнее сообщение пять минут назад.
    const s = closedSegments([msg(1, 0), msg(2, 5)], QUIET, at(10));
    expect(s).toEqual([]);
  });

  it('затихший хвост отдаём целиком', () => {
    const s = closedSegments([msg(1, 0), msg(2, 5)], QUIET, at(30));
    expect(s).toHaveLength(1);
    expect(s[0].endId).toBe('2');
  });

  it('закрытый разговор отдаём, а начатый после него — нет', () => {
    // Первый затих, второй только что начался.
    const s = closedSegments([msg(1, 0), msg(2, 60), msg(3, 62)], QUIET, at(63));
    expect(s.map((x) => x.startId)).toEqual(['1']);
  });

  it('лента бота разбору не подлежит: платить за неё столько же, толку никакого', () => {
    const bot = { authorId: null, isAi: true };
    expect(closedSegments([msg(1, 0, bot), msg(2, 2, bot)], QUIET, at(40))).toEqual([]);
  });

  it('сообщение бота внутри живого разговора отрезок не отменяет', () => {
    const s = closedSegments([msg(1, 0, { authorId: null, isAi: true }), msg(2, 2)], QUIET, at(40));
    expect(s).toHaveLength(1);
    expect(s[0].count).toBe(2);
  });

  it('очень длинный разговор режется на части: модель теряет начало', () => {
    const many = Array.from({ length: MAX_SEGMENT_MESSAGES + 10 }, (_, i) => msg(i + 1, i));
    const s = closedSegments(many, QUIET, at(MAX_SEGMENT_MESSAGES + 40));
    expect(s.length).toBeGreaterThan(1);
    expect(s[0].count).toBe(MAX_SEGMENT_MESSAGES);
    // Ничего не потеряли: части идут подряд.
    expect(s[1].startId).toBe(String(MAX_SEGMENT_MESSAGES + 1));
  });

  it('одно короткое поручение — тоже разговор', () => {
    // «Юра, сделай API до пятницы» и тишина: это полноценное поручение.
    const s = closedSegments([msg(1, 0)], QUIET, at(30));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ startId: '1', endId: '1', count: 1 });
  });

  it('пустой вход не роняет разбор', () => {
    expect(closedSegments([], QUIET, at(10))).toEqual([]);
  });
});
