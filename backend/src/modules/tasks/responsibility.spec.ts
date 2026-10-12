import { assigneeDelaySeconds, personalOverdue, responsibleOf, stageOfColumnName, taskStage } from './responsibility';

const at = (s: string) => new Date(s);

describe('ответственность за срок (ТЗ-30)', () => {
  it('тип этапа по названию колонки', () => {
    expect(stageOfColumnName('На тестировании')).toBe('testing');
    expect(stageOfColumnName(' QA ')).toBe('testing');
    expect(stageOfColumnName('Ревью')).toBe('review');
    expect(stageOfColumnName('На согласовании')).toBe('approval');
    expect(stageOfColumnName('Ждём клиента')).toBe('waiting_external');
    expect(stageOfColumnName('Готово')).toBe('done');
    expect(stageOfColumnName('В работе')).toBe('work');
    // по частям слова (жалоба 12.10: свои названия колонок не узнавались)
    expect(stageOfColumnName('На тесте')).toBe('testing');
    expect(stageOfColumnName('Тестируется')).toBe('testing');
    expect(stageOfColumnName('QA / тест')).toBe('testing');
    expect(stageOfColumnName('Ready for test')).toBe('testing');
    expect(stageOfColumnName('Проверка заказчиком')).toBe('review');
    expect(stageOfColumnName('Согласование с клиентом')).toBe('approval');
    expect(stageOfColumnName('Ждём ответа клиента')).toBe('waiting_external');
    expect(stageOfColumnName('К выполнению')).toBe('work');
    expect(stageOfColumnName('Новые')).toBe('work');
  });

  it('ждёт приёмки в «Готово» — согласование, закрыта — готово', () => {
    expect(taskStage({ columnStage: 'done', approvalState: 'pending' })).toBe('approval');
    expect(taskStage({ columnStage: 'testing', closedAt: at('2026-10-10') })).toBe('done');
  });

  it('сдал на проверку — личной просрочки нет, хоть срок и прошёл (п. 8)', () => {
    const now = at('2026-10-15T10:00:00Z');
    expect(personalOverdue({ stage: 'testing', deadline: at('2026-10-10T15:00:00Z'), now })).toBe(false);
    expect(personalOverdue({ stage: 'work', deadline: at('2026-10-10T15:00:00Z'), now })).toBe(true);
  });

  it('после возврата — срок доработки, а не старый срок (п. 12)', () => {
    const now = at('2026-10-15T10:00:00Z');
    expect(personalOverdue({ stage: 'work', deadline: at('2026-10-10T15:00:00Z'), fixDeadline: at('2026-10-16T09:00:00Z'), now })).toBe(false);
    expect(personalOverdue({ stage: 'work', deadline: at('2026-10-10T15:00:00Z'), fixDeadline: at('2026-10-15T09:00:00Z'), now })).toBe(true);
  });

  it('опоздание исполнителя — только до сдачи (п. 9–10)', () => {
    const now = at('2026-10-15T10:00:00Z');
    // сдал на 16 часов позже срока, QA держит 4 дня — опоздание 16 часов
    expect(assigneeDelaySeconds({ deadline: at('2026-10-10T15:00:00Z'), firstSubmittedAt: at('2026-10-11T07:00:00Z'), now })).toBe(16 * 3600);
    // сдал до срока — опоздания нет, сколько бы ни проверяли
    expect(assigneeDelaySeconds({ deadline: at('2026-10-10T15:00:00Z'), firstSubmittedAt: at('2026-10-10T11:00:00Z'), closedAt: at('2026-10-15T09:00:00Z'), now })).toBe(0);
  });

  it('кто держит задачу: проверка и приёмка — постановщик, клиент — клиент', () => {
    expect(responsibleOf({ stage: 'testing', assigneeId: '1', creatorId: '2' })).toEqual({ type: 'reviewer', userId: '2' });
    expect(responsibleOf({ stage: 'approval', assigneeId: '1', creatorId: '2' })).toEqual({ type: 'approver', userId: '2' });
    expect(responsibleOf({ stage: 'waiting_external', assigneeId: '1', creatorId: '2' }).type).toBe('client');
    expect(responsibleOf({ stage: 'work', assigneeId: '1', creatorId: '2' })).toEqual({ type: 'assignee', userId: '1' });
  });
});
