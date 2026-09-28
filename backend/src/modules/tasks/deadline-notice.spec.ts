import { humanDeadline, noticeDue, noticeText, SOON_MS } from './deadline-notice';

/**
 * Предупреждения о сроке: что и когда говорим.
 *
 * Проверяем не тексты как таковые, а обещания: ничего не говорим раньше суток, не
 * повторяемся, про закрытую задачу молчим, а при долгом простое говорим главное —
 * «просрочена», а не «скоро просрочится».
 */
describe('предупреждение о сроке задачи', () => {
  const now = new Date('2026-09-21T09:00:00.000Z');
  const base = { closed: false, said: [] as ('soon' | 'overdue')[], now };

  it('раньше суток — молчим', () => {
    const later = new Date(now.getTime() + SOON_MS + 60_000);
    expect(noticeDue({ ...base, deadlineAt: later })).toBeNull();
  });

  it('за сутки — «почти просрочена», и ровно один раз', () => {
    const soon = new Date(now.getTime() + 3 * 60 * 60_000);
    expect(noticeDue({ ...base, deadlineAt: soon })).toBe('soon');
    expect(noticeDue({ ...base, deadlineAt: soon, said: ['soon'] })).toBeNull();
  });

  it('срок прошёл — «просрочена», и тоже один раз', () => {
    const past = new Date(now.getTime() - 60_000);
    expect(noticeDue({ ...base, deadlineAt: past })).toBe('overdue');
    expect(noticeDue({ ...base, deadlineAt: past, said: ['overdue'] })).toBeNull();
  });

  it('планировщик стоял — говорим главное, пропущенное «скоро» не досылаем', () => {
    const past = new Date(now.getTime() - 2 * SOON_MS);
    // ни о чём сказать не успели: всё равно первым идёт «просрочена»
    expect(noticeDue({ ...base, deadlineAt: past })).toBe('overdue');
    // о «скоро» уже говорили — это ничего не меняет
    expect(noticeDue({ ...base, deadlineAt: past, said: ['soon'] })).toBe('overdue');
  });

  it('закрытая задача молчит даже с прошедшим сроком', () => {
    const past = new Date(now.getTime() - 60_000);
    expect(noticeDue({ ...base, deadlineAt: past, closed: true })).toBeNull();
  });

  it('срок переехал — предупреждаем заново', () => {
    /*
      Отметки хранятся вместе со сроком, поэтому у нового срока список сказанного
      пуст. Это не мелочь: перенос — новое обещание, и о нём предупреждают снова.
    */
    const moved = new Date(now.getTime() + 60 * 60_000);
    expect(noticeDue({ ...base, deadlineAt: moved, said: [] })).toBe('soon');
  });

  it('текст зовёт исполнителя по имени, а без исполнителя говорит и об этом', () => {
    const when = '21 сентября 2026, 15:00';
    expect(noticeText('soon', 'Пётр Коллега', when))
      .toBe('Пётр Коллега, задача почти просрочена. Крайний срок задачи 21 сентября 2026, 15:00');
    expect(noticeText('overdue', 'Пётр Коллега', when)).toContain('задача просрочена 21 сентября 2026, 15:00');
    expect(noticeText('soon', null, when)).toContain('исполнитель не назначен');
    expect(noticeText('overdue', null, when)).toContain('Назначьте исполнителя');
  });

  it('срок читается в поясе исполнителя и без « г.» в конце', () => {
    const at = new Date('2026-09-21T12:00:00.000Z');
    expect(humanDeadline(at, 'Europe/Moscow')).toBe('21 сентября 2026, 15:00');
    // тот же миг во Владивостоке — уже вечер, и в тексте должно стоять местное время
    expect(humanDeadline(at, 'Asia/Vladivostok')).toBe('21 сентября 2026, 22:00');
  });
});
