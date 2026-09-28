import { ASK_FROM_MS, ASK_TO_MS, askText, effectsOf, shiftTarget, shouldAsk } from './followup-rules';

describe('догоняющий вопрос по задаче', () => {
  const now = new Date('2026-09-28T09:00:00.000Z');
  const base = {
    now, closed: false, waitingApproval: false, hasAssignee: true, asked: false, working: true,
  };
  const inHours = (h: number) => new Date(now.getTime() + h * 60 * 60_000);

  it('спрашиваем в окне 4–6 часов до срока, не раньше и не позже', () => {
    expect(shouldAsk({ ...base, deadlineAt: inHours(5) })).toBe(true);
    // за семь часов рано: ответ «успеваю» ещё ничего не значит
    expect(shouldAsk({ ...base, deadlineAt: inHours(7) })).toBe(false);
    // за три часа поздно: это уже не вопрос, а укор
    expect(shouldAsk({ ...base, deadlineAt: inHours(3) })).toBe(false);
    // границы окна заданы теми же константами, по которым работает планировщик
    expect(ASK_FROM_MS).toBeGreaterThan(ASK_TO_MS);
  });

  it('молчим, когда спрашивать некого или не о чем', () => {
    const due = inHours(5);
    expect(shouldAsk({ ...base, deadlineAt: due, closed: true })).toBe(false);
    expect(shouldAsk({ ...base, deadlineAt: due, waitingApproval: true })).toBe(false);
    expect(shouldAsk({ ...base, deadlineAt: due, hasAssignee: false })).toBe(false);
  });

  it('спрашиваем ОДИН раз про один срок', () => {
    expect(shouldAsk({ ...base, deadlineAt: inHours(5), asked: true })).toBe(false);
  });

  it('ночью и в выходной не спрашиваем вовсе, а не откладываем', () => {
    // вопрос в три часа ночи работу не ускорит, а доверие потратит
    expect(shouldAsk({ ...base, deadlineAt: inHours(5), working: false })).toBe(false);
  });

  it('«успеваю» не делает ничего, кроме записи ответа', () => {
    expect(effectsOf('on_track')).toEqual({ markBlocked: false, askShift: false, notifyManager: false });
  });

  it('«блокер» помечает задачу и зовёт постановщика, «перенос» — просит сдвинуть срок', () => {
    expect(effectsOf('blocked')).toEqual({ markBlocked: true, askShift: false, notifyManager: true });
    expect(effectsOf('need_shift')).toEqual({ markBlocked: false, askShift: true, notifyManager: true });
  });

  it('текст вопроса называет задачу и срок, длинное название обрезает', () => {
    expect(askText('Собрать отчёт', 'сегодня в 18:00'))
      .toBe('Как идёт работа по задаче «Собрать отчёт»? Срок сегодня в 18:00');
    const long = 'а'.repeat(200);
    expect(askText(long, 'завтра').length).toBeLessThan(140);
    expect(askText(long, 'завтра')).toContain('…');
  });

  it('перенос: назад не двигаем, без даты — на сутки, дальше года не пускаем', () => {
    const deadline = inHours(5);
    // попросили вчерашнее — берём сутки от срока
    expect(shiftTarget(new Date(now.getTime() - 86_400_000), deadline, now).getTime())
      .toBe(deadline.getTime() + 86_400_000);
    // не попросили ничего — те же сутки
    expect(shiftTarget(null, deadline, now).getTime()).toBe(deadline.getTime() + 86_400_000);
    // попросили разумное — отдаём как есть
    const wanted = inHours(30);
    expect(shiftTarget(wanted, deadline, now).getTime()).toBe(wanted.getTime());
    // попросили через пять лет — это не перенос, а отмена
    const far = new Date(now.getTime() + 5 * 365 * 86_400_000);
    expect(shiftTarget(far, deadline, now).getTime()).toBeLessThan(far.getTime());
  });
});
