import { Candidate, deadlineScore, pickTop3, scoreCandidate } from './rule-of-3';

const TZ = 'Europe/Moscow';
// 7 октября, 10:00 по Москве
const NOW = new Date('2026-10-07T07:00:00Z');
const msk = (iso: string) => new Date(`${iso}+03:00`);

let n = 0;
const task = (over: Partial<Candidate> = {}): Candidate => {
  n += 1;
  return {
    kind: 'task', key: `task:${n}`, taskId: String(n), approvalId: null, title: `Задача ${n}`,
    projectName: 'P', deadlineAt: null, priority: 'normal', isBlocked: false,
    waiting: 0, waitingName: null, meeting: 0, meetingTitle: null, pinned: false, estimateHours: null,
    ...over,
  };
};
const score = (c: Candidate) => scoreCandidate(c, NOW, TZ);

describe('срок', () => {
  it('шкала из ТЗ по местным суткам', () => {
    expect(deadlineScore(msk('2026-10-05T12:00:00'), NOW, TZ).score).toBe(100);
    expect(deadlineScore(msk('2026-10-07T18:00:00'), NOW, TZ).score).toBeGreaterThanOrEqual(95);
    expect(deadlineScore(msk('2026-10-08T12:00:00'), NOW, TZ).score).toBe(75);
    expect(deadlineScore(msk('2026-10-10T12:00:00'), NOW, TZ).score).toBe(55);
    expect(deadlineScore(msk('2026-10-13T12:00:00'), NOW, TZ).score).toBe(40);
    expect(deadlineScore(msk('2026-11-20T12:00:00'), NOW, TZ).score).toBe(20);
    expect(deadlineScore(null, NOW, TZ).score).toBe(15);
  });

  it('сегодня в 11:00 срочнее, чем сегодня в 18:00', () => {
    expect(deadlineScore(msk('2026-10-07T11:00:00'), NOW, TZ).score)
      .toBeGreaterThan(deadlineScore(msk('2026-10-07T18:00:00'), NOW, TZ).score);
  });

  it('объяснение говорит по-человечески и по местному времени', () => {
    expect(deadlineScore(msk('2026-10-07T14:00:00'), NOW, TZ).reason).toBe('срок сегодня в 14:00');
    expect(deadlineScore(msk('2026-10-04T14:00:00'), NOW, TZ).reason).toBe('просрочена на 3 дня');
  });

  it('сутки — в поясе человека: 23:30 по Москве для Новосибирска уже завтра', () => {
    const at = msk('2026-10-07T23:30:00');
    expect(deadlineScore(at, NOW, 'Europe/Moscow').score).toBeGreaterThanOrEqual(95);
    expect(deadlineScore(at, NOW, 'Asia/Novosibirsk').score).toBe(75);
  });
});

describe('очки и объяснение', () => {
  it('формула v1: 0.35·срок + 0.30·разблокирует + 0.25·созвон + 0.10·приоритет', () => {
    const s = score(task({ deadlineAt: msk('2026-10-08T12:00:00'), priority: 'high', waiting: 1, meeting: 100 }));
    expect(s.score).toBeCloseTo(0.35 * 75 + 0.30 * 30 + 0.25 * 100 + 0.10 * 80, 1);
  });

  it('заблокированная не становится главной из-за срока', () => {
    const blocked = score(task({ deadlineAt: msk('2026-10-05T12:00:00'), isBlocked: true }));
    const free = score(task({ deadlineAt: msk('2026-10-08T12:00:00') }));
    expect(blocked.score).toBeLessThan(free.score);
    expect(blocked.worthy).toBe(false);
    expect(blocked.reasons).toContain('отмечена заблокированной — поэтому ниже');
  });

  it('проверка чужой работы объясняет, кто ждёт', () => {
    const s = score(task({ kind: 'review', waiting: 1, waitingName: 'Глеб' }));
    expect(s.reasons).toContain('Глеб ждёт, когда вы примете работу');
    expect(s.worthy).toBe(true);
  });

  it('задача без срока и с обычным приоритетом в тройку сама не лезет', () => {
    expect(score(task()).worthy).toBe(false);
  });
});

describe('выбор тройки', () => {
  it('0 кандидатов — пусто, без выдуманного', () => {
    expect(pickTop3([])).toEqual([]);
  });

  it('достойных двое — в тройке двое (третье место не добиваем)', () => {
    const picked = pickTop3([
      score(task({ deadlineAt: msk('2026-10-07T15:00:00') })),
      score(task({ priority: 'urgent' })),
      score(task()), score(task()),
    ]);
    expect(picked).toHaveLength(2);
  });

  it('30 просроченных — ровно три, и первой самая весомая', () => {
    const many = Array.from({ length: 30 }, (_, i) => score(task({ deadlineAt: msk('2026-10-01T12:00:00'), priority: i === 17 ? 'urgent' : 'normal' })));
    const picked = pickTop3(many);
    expect(picked).toHaveLength(3);
    expect(picked[0].priority).toBe('urgent');
  });

  it('закреплённое человеком остаётся, даже если очков мало', () => {
    const pin = score(task({ pinned: true }));
    const strong = [1, 2, 3].map(() => score(task({ deadlineAt: msk('2026-10-07T12:00:00'), priority: 'urgent' })));
    const picked = pickTop3([...strong, pin]);
    expect(picked.map((p) => p.key)).toContain(pin.key);
    expect(picked).toHaveLength(3);
  });

  it('не больше двух проверок, если есть своя достойная задача', () => {
    const reviews = [1, 2, 3].map(() => score(task({ kind: 'review', waiting: 3, deadlineAt: msk('2026-10-06T12:00:00') })));
    const own = score(task({ deadlineAt: msk('2026-10-09T12:00:00') }));
    const picked = pickTop3([...reviews, own]);
    expect(picked.filter((p) => p.kind === 'review')).toHaveLength(2);
    expect(picked.map((p) => p.key)).toContain(own.key);
  });

  it('три задачи по 5 часов не влезают в 4 свободных часа', () => {
    const big = [1, 2, 3].map(() => score(task({ deadlineAt: msk('2026-10-07T18:00:00'), estimateHours: 5 })));
    expect(pickTop3(big, { freeHours: 4 })).toHaveLength(1);
  });
});
