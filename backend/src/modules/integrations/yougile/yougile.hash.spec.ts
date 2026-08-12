import { createHash } from 'crypto';
import { chatEchoKey, taskStateHash } from './yougile.hash';

describe('YouGile: хеш состояния задачи и ключ своего сообщения', () => {
  const sample = {
    title: 'Задача 1',
    description: 'детали',
    localColumnId: '42',
    assigned: ['u1', 'u2'],
    deadlineIso: '2030-01-01T00:00:00.000Z',
    completed: false,
    priority: 'high',
  };

  it('считается по фиксированному составу полей (импорт и выгрузка должны совпадать)', () => {
    const expected = createHash('sha256')
      .update(['Задача 1', 'детали', '42', 'u1,u2', '2030-01-01T00:00:00.000Z', '0', 'high'].join('|'))
      .digest('hex').slice(0, 64);
    expect(taskStateHash(sample)).toBe(expected);
  });

  it('различает приоритет — иначе смена приоритета в YouGile не доехала бы до CRM', () => {
    expect(taskStateHash({ ...sample, priority: 'urgent' })).not.toBe(taskStateHash(sample));
  });

  it('пустое описание и отсутствие срока дают тот же хеш, что null (импорт кладёт null)', () => {
    expect(taskStateHash({ ...sample, description: '', deadlineIso: null }))
      .toBe(taskStateHash({ ...sample, description: null, deadlineIso: null }));
  });

  it('различает перенос, исполнителя и закрытие задачи', () => {
    const base = taskStateHash(sample);
    expect(taskStateHash({ ...sample, localColumnId: '43' })).not.toBe(base);
    expect(taskStateHash({ ...sample, assigned: ['u2', 'u1'] })).not.toBe(base);
    expect(taskStateHash({ ...sample, completed: true })).not.toBe(base);
  });

  it('ключ своего сообщения влезает в external_refs.external_id (64 символа) и зависит от задачи и текста', () => {
    const k = chatEchoKey('7f8e9d0c-1234-4567-89ab-cdef01234567', 'Иван Петров: привет');
    expect(k.length).toBeLessThanOrEqual(64);
    expect(k).toMatch(/^e:[0-9a-f]{40}$/);
    expect(chatEchoKey('t1', 'текст')).not.toBe(chatEchoKey('t2', 'текст'));
    expect(chatEchoKey('t1', 'текст')).not.toBe(chatEchoKey('t1', 'другой'));
  });
});
