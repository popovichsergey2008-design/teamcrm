import {
  canApplyChange, changeAskText, changeReadiness, newAssigneeOf, parseYesNo, resolveChangeTarget,
} from './change-rules';

const src = (o: Partial<{ messageId: string; authorId: string | null; sharedTaskId: string | null; text: string }>) => ({
  messageId: '1', authorId: '10', sharedTaskId: null, text: '', ...o,
});

describe('resolveChangeTarget', () => {
  it('названный номер — уверенность 1', () => {
    expect(resolveChangeTarget({ sources: [src({ text: '#77 не делай' })], alive: new Set(['77']), modelTaskId: null, bornHere: new Set() }))
      .toEqual({ taskId: '77', confidence: 1 });
  });
  it('выбор модели — только среди задач, родившихся в этом чате', () => {
    expect(resolveChangeTarget({ sources: [src({ text: 'не делай пока' })], alive: new Set(), modelTaskId: '55', bornHere: new Set(['55']) }))
      .toEqual({ taskId: '55', confidence: 0.9 });
    expect(resolveChangeTarget({ sources: [src({ text: 'не делай пока' })], alive: new Set(), modelTaskId: '56', bornHere: new Set(['55']) }).taskId)
      .toBeNull();
  });
  it('названо несколько задач — не выбираем даже из родившихся здесь', () => {
    const r = resolveChangeTarget({
      sources: [src({ text: '#55 и #56 отменяем' })], alive: new Set(['55', '56']), modelTaskId: '55', bornHere: new Set(['55']),
    });
    expect(r.taskId).toBeNull();
  });
});

describe('changeReadiness', () => {
  const current = { assigneeId: '5', deadline: new Date('2026-10-02T15:00:00Z') };
  const base = { intent: 0.95, taskId: '7', newAssigneeId: null, newDeadline: null, current };

  it('отмена готова сразу', () => {
    expect(changeReadiness({ ...base, kind: 'cancel' })).toBe('ready');
  });
  it('переназначение — только на другого и названного', () => {
    expect(changeReadiness({ ...base, kind: 'reassign', newAssigneeId: '6' })).toBe('ready');
    expect(changeReadiness({ ...base, kind: 'reassign', newAssigneeId: '5' })).toBe('noop');
    expect(changeReadiness({ ...base, kind: 'reassign' })).toBe('detected');
  });
  it('перенос на тот же срок — не изменение', () => {
    expect(changeReadiness({ ...base, kind: 'deadline', newDeadline: new Date('2026-10-05T15:00:00Z') })).toBe('ready');
    expect(changeReadiness({ ...base, kind: 'deadline', newDeadline: new Date('2026-10-02T15:00:00Z') })).toBe('noop');
  });
  it('без задачи или без уверенности — только замечено', () => {
    expect(changeReadiness({ ...base, kind: 'cancel', taskId: null })).toBe('detected');
    expect(changeReadiness({ ...base, kind: 'cancel', intent: 0.6 })).toBe('detected');
    expect(changeReadiness({ ...base, kind: 'что-то' })).toBe('detected');
  });
});

describe('newAssigneeOf', () => {
  it('названный или вызвавшийся — да, догадка — нет', () => {
    expect(newAssigneeOf({ modelAssigneeId: '6', named: ['6'], authors: [] })).toBe('6');
    expect(newAssigneeOf({ modelAssigneeId: '6', named: [], authors: ['6'] })).toBe('6');
    expect(newAssigneeOf({ modelAssigneeId: '6', named: ['7'], authors: ['8'] })).toBeNull();
  });
});

describe('canApplyChange', () => {
  it('постановщик или владелец', () => {
    expect(canApplyChange({ userId: '1', role: 'member', creatorId: '1' })).toBe(true);
    expect(canApplyChange({ userId: '2', role: 'owner', creatorId: '1' })).toBe(true);
    expect(canApplyChange({ userId: '2', role: 'manager', creatorId: '1' })).toBe(false);
  });
});

describe('parseYesNo', () => {
  it.each([['да', 'yes'], ['Да, отменяй', 'yes'], ['ок', 'yes'], ['оставить', 'no'], ['нет, оставь', 'no'], ['не надо', 'no'], ['не отменяй', 'no']])(
    '«%s» → %s', (t, v) => expect(parseYesNo(t)).toBe(v),
  );
  it.each([['подумаю'], ['да нет, наверное'], ['']])('«%s» — не ответ', (t) => expect(parseYesNo(t)).toBeNull());
  it('слово внутри другого не считается', () => {
    expect(parseYesNo('данные пришли')).toBeNull();
  });
});

describe('changeAskText', () => {
  it('называет задачу, изменение и что ответить', () => {
    const t = changeAskText({ who: 'Ольга', kind: 'reassign', taskId: '7', title: 'API', assigneeName: 'Глеб', deadlineLabel: null });
    expect(t).toContain('Ольга, по задаче #7 «API» похоже, исполнителем теперь будет Глеб. Переназначить?');
    expect(t).toContain('«да» или «оставить»');
  });
});
