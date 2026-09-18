import { Actor, canTransition, Status, TRANSITIONS, whyNot } from './support-status';

/**
 * Правила переходов.
 *
 * Проверяем обязанности, а не таблицу: закрывает только клиент, инженер не ведёт
 * разговор, помощник умеет лишь отдать людям. Ошибка здесь не падает — она тихо
 * разрешает не то, и находится через месяц по жалобе.
 */
describe('состояния обращения', () => {
  it('закрыть обращение может только тот, кто обратился', () => {
    for (const from of Object.keys(TRANSITIONS) as Status[]) {
      if (from === 'closed') continue;
      for (const actor of ['agent', 'engineer', 'ai'] as Actor[]) {
        expect(canTransition(from, 'closed', actor)).toBe(false);
      }
    }
    expect(canTransition('waiting_user', 'closed', 'client')).toBe(true);
    expect(canTransition('ai', 'closed', 'client')).toBe(true);
  });

  it('помощник умеет только передать людям', () => {
    expect(canTransition('ai', 'waiting_agent', 'ai')).toBe(true);
    expect(canTransition('ai', 'in_progress', 'ai')).toBe(false);
    expect(canTransition('in_progress', 'waiting_agent', 'ai')).toBe(false);
  });

  it('инженер отмечает починку, но не ведёт разговор', () => {
    expect(canTransition('engineer_escalated', 'fix_in_progress', 'engineer')).toBe(true);
    expect(canTransition('fix_in_progress', 'in_progress', 'engineer')).toBe(true);
    // просить подтверждения у клиента — дело специалиста, а не инженера
    expect(canTransition('fix_in_progress', 'waiting_user', 'engineer')).toBe(false);
    expect(canTransition('in_progress', 'waiting_reply', 'engineer')).toBe(false);
  });

  it('эскалация к инженеру — право дежурного', () => {
    expect(canTransition('in_progress', 'engineer_escalated', 'agent')).toBe(true);
    expect(canTransition('in_progress', 'engineer_escalated', 'client')).toBe(false);
  });

  it('открыть заново может только автор', () => {
    expect(canTransition('closed', 'waiting_agent', 'client')).toBe(true);
    expect(canTransition('closed', 'waiting_agent', 'agent')).toBe(false);
  });

  it('возврат в то же состояние не считается переходом', () => {
    expect(canTransition('in_progress', 'in_progress', 'engineer')).toBe(true);
  });

  it('объяснение отказа зависит от причины, а не от места', () => {
    expect(whyNot('waiting_user', 'closed', 'agent')).toContain('только тот, кто обратился');
    expect(whyNot('ai', 'fix_in_progress', 'agent')).toContain('так не переводится');
    expect(whyNot('in_progress', 'waiting_reply', 'engineer')).toContain('Инженер не ведёт разговор');
  });
});
