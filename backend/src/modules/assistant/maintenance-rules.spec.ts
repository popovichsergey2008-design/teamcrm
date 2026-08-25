import {
  Candidate, DEFAULT_THRESHOLDS, daysWord, dedupKey, limitCandidates, MAX_PROPOSALS_PER_RUN, proposalText, undoOf,
} from './maintenance-rules';

const cand = (p: Partial<Candidate> = {}): Candidate => ({
  kind: 'task_stale', subjectId: '10', title: 'Согласовать смету', days: 62, context: 'Стройка', ...p,
});

describe('Уборка — правила', () => {
  it('пороги остаются большими: уборщик не лезет под руку', () => {
    expect(DEFAULT_THRESHOLDS.taskDays).toBeGreaterThanOrEqual(60);
    expect(DEFAULT_THRESHOLDS.projectDays).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_THRESHOLDS.draftDays).toBeGreaterThanOrEqual(30);
  });

  it('дни склоняются', () => {
    expect(daysWord(1)).toBe('1 день');
    expect(daysWord(62)).toBe('62 дня');
    expect(daysWord(65)).toBe('65 дней');
    expect(daysWord(111)).toBe('111 дней');
    expect(daysWord(0.4)).toBe('1 день'); // меньше суток всё равно называем сутками
  });

  it('текст — предложение с причиной, а не сообщение о сделанном', () => {
    expect(proposalText(cand())).toBe(
      'Задача не двигалась 62 дня — предлагаю закрыть: «Согласовать смету» (Стройка)',
    );
    expect(proposalText(cand({ kind: 'project_idle', title: 'Стройка', days: 40, context: null })))
      .toContain('предлагаю сдать проект в архив');
    expect(proposalText(cand({ kind: 'draft_stale', title: 'Позвонить подрядчику', days: 31 })))
      .toContain('предлагаю отклонить');
  });

  it('без проекта формулировка остаётся целой', () => {
    expect(proposalText(cand({ context: null }))).toBe(
      'Задача не двигалась 62 дня — предлагаю закрыть: «Согласовать смету»',
    );
  });

  it('ключ повтора привязан к объекту, а не ко дню: спрашиваем один раз', () => {
    expect(dedupKey(cand())).toBe('task_stale:10');
    expect(dedupKey(cand({ kind: 'draft_stale' }))).toBe('draft_stale:10');
  });

  it('в откат кладётся прежнее состояние вместе с видом действия', () => {
    expect(undoOf(cand(), { columnId: '5', position: 2 })).toEqual({
      kind: 'task_stale', subjectId: '10', columnId: '5', position: 2,
    });
  });

  it('за раз показываем немного и начинаем с самого старого', () => {
    const many = Array.from({ length: 25 }, (_, i) => cand({ subjectId: String(i), days: i }));
    const picked = limitCandidates(many);
    expect(picked).toHaveLength(MAX_PROPOSALS_PER_RUN);
    expect(picked[0].days).toBe(24);
    expect(picked[picked.length - 1].days).toBe(15);
  });
});
