import { affectsOthers, autonomyOf, decide, DEFAULT_AUTONOMY, maxRisk, permissionFor, policyOf, TOOL_POLICY } from './tool-policy';
import { isPermission } from '../security/permissions';

describe('tool-policy', () => {
  it('у каждого права в таблице — настоящее имя права', () => {
    for (const [name, pol] of Object.entries(TOOL_POLICY)) {
      if (typeof pol.permission === 'string') expect([name, isPermission(pol.permission)]).toEqual([name, true]);
    }
    expect(permissionFor('update_task', { assigneeId: '5' })).toBe('task.assign');
    expect(permissionFor('update_task', { deadline: 'x' })).toBe('task.edit');
    expect(permissionFor('create_document', { target: 'notes' })).toBeNull();
  });

  it('неизвестный инструмент — самый строгий', () => {
    expect(policyOf('drop_everything').risk).toBe('high_write');
    expect(affectsOthers('drop_everything', {})).toBe(true);
  });

  it('то, что задевает других, само не выполняется даже в режиме auto', () => {
    const all = autonomyOf({ self: 'auto', tasks: 'auto', messages: 'auto', calendar: 'auto', documents: 'auto' });
    expect(decide('send_message', {}, all)).toBe('confirm');
    expect(decide('create_task', {}, all)).toBe('confirm');
    expect(decide('create_event', { participantIds: ['2'] }, all)).toBe('confirm');
    expect(decide('create_event', { participantIds: [] }, all)).toBe('auto');
    expect(decide('create_document', { target: 'notes' }, all)).toBe('auto');
    expect(decide('create_document', { target: 'chat' }, all)).toBe('confirm');
  });

  it('по умолчанию сам выполняется только «для себя»', () => {
    expect(decide('create_reminder', {}, DEFAULT_AUTONOMY)).toBe('auto');
    expect(decide('create_event', {}, DEFAULT_AUTONOMY)).toBe('confirm');
    expect(decide('search_tasks', {}, DEFAULT_AUTONOMY)).toBe('auto');
  });

  it('ужесточить можно, мусор в настройке не ломает', () => {
    const a = autonomyOf({ self: 'off', tasks: 'suggest', messages: 'everything' });
    expect(decide('remember', {}, a)).toBe('off');
    expect(decide('create_task', {}, a)).toBe('suggest');
    expect(decide('send_message', {}, a)).toBe('confirm');
  });

  it('риск прогона — самый высокий из шагов', () => {
    expect(maxRisk(['low_write', 'high_write', 'read'])).toBe('high_write');
    expect(maxRisk([])).toBe('read');
  });
});
