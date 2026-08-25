import { DEFAULT_GATE, GateFacts, handoffGate } from './handoff-gate';

const facts = (p: Partial<GateFacts> = {}): GateFacts =>
  ({ checklistTotal: 0, checklistDone: 0, ownComments: 1, attachments: 1, ...p });

describe('Приёмка работы', () => {
  it('всё на месте — гейт молчит', () => {
    expect(handoffGate(DEFAULT_GATE, facts({ checklistTotal: 3, checklistDone: 3 }))).toEqual([]);
  });

  it('незакрытый чек-лист называет, сколько пунктов осталось', () => {
    const miss = handoffGate(DEFAULT_GATE, facts({ checklistTotal: 5, checklistDone: 2 }));
    expect(miss).toHaveLength(1);
    expect(miss[0].code).toBe('checklist');
    expect(miss[0].text).toContain('3 из 5');
  });

  it('чек-листа нет — придираться не к чему', () => {
    expect(handoffGate(DEFAULT_GATE, facts({ checklistTotal: 0, checklistDone: 0 }))).toEqual([]);
  });

  it('нет отчёта исполнителя и нет вложения — обе нехватки сразу', () => {
    const miss = handoffGate(DEFAULT_GATE, facts({ ownComments: 0, attachments: 0 }));
    expect(miss.map((m) => m.code)).toEqual(['comment', 'attachment']);
  });

  it('выключенное условие не проверяется', () => {
    const req = { checklist: true, comment: false, attachment: false };
    expect(handoffGate(req, facts({ ownComments: 0, attachments: 0 }))).toEqual([]);
  });

  it('все условия выключены — гейт не мешает никому', () => {
    const req = { checklist: false, comment: false, attachment: false };
    expect(handoffGate(req, facts({ checklistTotal: 4, checklistDone: 0, ownComments: 0, attachments: 0 }))).toEqual([]);
  });
});
