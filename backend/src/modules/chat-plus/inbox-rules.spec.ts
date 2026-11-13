import { ago, isAsk, Msg, myUnanswered, waitingForMe } from './inbox-rules';

const now = new Date('2026-11-13T15:00:00Z');
const h = (n: number) => new Date(now.getTime() - n * 3_600_000);
let seq = 0;
const msg = (p: Partial<Msg>): Msg => ({
  id: String(++seq), chatId: '1', chatKind: 'dm', chatTitle: null, authorId: '2', author: 'Лена', body: 'Когда будет макет?',
  at: h(5), threadRootId: null, mentionsMe: false, ...p,
});

describe('inbox-rules (#4902, пп. 5–6)', () => {
  it('вопрос и просьба', () => {
    expect(isAsk('Когда будет макет?')).toBe(true);
    expect(isAsk('@Сергей посмотри договор')).toBe(true);
    expect(isAsk('Ок, спасибо')).toBe(false);
    expect(isAsk('а ты сможешь завтра')).toBe(true);
  });

  it('ждут ответа: личка старше 4 ч без моего ответа', () => {
    const q = msg({});
    expect(waitingForMe([q], '1', now).map((m) => m.id)).toEqual([q.id]);
    expect(waitingForMe([msg({ at: h(2) })], '1', now)).toEqual([]);
  });

  it('ответил позже — пропадает', () => {
    const q = msg({});
    const a = msg({ authorId: '1', body: 'Завтра', at: h(1) });
    expect(waitingForMe([q, a], '1', now)).toEqual([]);
  });

  it('в группе — только с упоминанием', () => {
    expect(waitingForMe([msg({ chatKind: 'group' })], '1', now)).toEqual([]);
    expect(waitingForMe([msg({ chatKind: 'group', mentionsMe: true })], '1', now)).toHaveLength(1);
  });

  it('ответ в ветке на вопрос закрывает его', () => {
    const q = msg({ chatKind: 'group', mentionsMe: true });
    const a = msg({ authorId: '1', body: 'Да', at: h(1), threadRootId: q.id });
    expect(waitingForMe([q, a], '1', now)).toEqual([]);
  });

  it('мои вопросы без ответа больше суток', () => {
    const mine = msg({ authorId: '1', body: 'Пришли счёт?', at: h(30) });
    expect(myUnanswered([mine], '1', now)).toHaveLength(1);
    expect(myUnanswered([mine, msg({ body: 'Держи', at: h(2) })], '1', now)).toEqual([]);
  });

  it('давность', () => {
    expect(ago(h(5), now)).toBe('5 ч');
    expect(ago(h(50), now)).toBe('2 дн.');
  });
});
