import { Candidate, pickAgent } from './support-routing';

const agent = (userId: string, over: Partial<Candidate> = {}): Candidate => ({
  userId, skills: [], onDuty: true, online: true, load: 0, maxLoad: 5, ...over,
});

/**
 * Выбор исполнителя.
 *
 * Проверяем обещания, а не арифметику: умеющий важнее свободного, перегруженному не
 * дают, при равенстве выбор одинаковый, а «брать некому» — законный ответ, а не сбой.
 */
describe('маршрутизация обращений', () => {
  const plain = { requiredSkill: null, previousAgentId: null, tenantAgentIds: [] };

  it('умеющий важнее свободного', () => {
    const r = pickAgent(
      { ...plain, requiredSkill: 'imports' },
      [agent('1', { load: 0 }), agent('2', { skills: ['imports'], load: 2 })],
    );
    expect(r.agentId).toBe('2');
    expect(r.reason).toBe('по навыку');
  });

  it('но не любой ценой: сильно загруженного умеющего обгоняет свободный', () => {
    const r = pickAgent(
      { ...plain, requiredSkill: 'imports' },
      [agent('1', { load: 0 }), agent('2', { skills: ['imports'], load: 6, maxLoad: 9 })],
    );
    expect(r.agentId).toBe('1');
  });

  it('перегруженным не назначаем вовсе', () => {
    const r = pickAgent(plain, [agent('1', { load: 5, maxLoad: 5 })]);
    expect(r.agentId).toBeNull();
    expect(r.reason).toBe('все заняты');
  });

  it('снятых с дежурства не рассматриваем', () => {
    const r = pickAgent(plain, [agent('1', { onDuty: false }), agent('2', { onDuty: true })]);
    expect(r.agentId).toBe('2');
    expect(r.considered.map((c) => c.userId)).toEqual(['2']);
  });

  it('дежурных нет — это законный ответ, а не сбой', () => {
    const r = pickAgent(plain, [agent('1', { onDuty: false })]);
    expect(r.agentId).toBeNull();
    expect(r.reason).toBe('нет дежурных');
  });

  it('при равенстве возвращает того, кто уже вёл этого человека', () => {
    const r = pickAgent(
      { ...plain, previousAgentId: '2' },
      [agent('1'), agent('2')],
    );
    expect(r.agentId).toBe('2');
    expect(r.reason).toBe('вёл этого клиента');
  });

  it('знакомство с компанией слабее личного знакомства', () => {
    const r = pickAgent(
      { ...plain, previousAgentId: '1', tenantAgentIds: ['2'] },
      [agent('1'), agent('2')],
    );
    expect(r.agentId).toBe('1');
  });

  it('кого нет на месте — в последнюю очередь', () => {
    const r = pickAgent(plain, [agent('1', { online: false }), agent('2', { online: true })]);
    expect(r.agentId).toBe('2');
  });

  it('при полном равенстве выбор одинаковый: иначе его не объяснить', () => {
    const a = pickAgent(plain, [agent('7'), agent('3'), agent('5')]);
    const b = pickAgent(plain, [agent('5'), agent('7'), agent('3')]);
    expect(a.agentId).toBe('3');
    expect(b.agentId).toBe('3');
  });

  it('навык не назван — выбираем по свободе, а не наугад', () => {
    const r = pickAgent(plain, [agent('1', { skills: ['billing'], load: 3 }), agent('2', { load: 0 })]);
    expect(r.agentId).toBe('2');
    expect(r.reason).toBe('свободнее всех');
  });
});
