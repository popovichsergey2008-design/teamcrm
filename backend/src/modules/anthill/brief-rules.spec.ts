import { briefDue, eveningText, morningText } from './brief-rules';

const TZ = 'Europe/Moscow';
const local = (hour: number, minute: number, dow = 3, date = '2026-10-07') => ({ hour, minute, dow, date });

describe('brief-rules', () => {
  it('пора слать: с назначенной минуты и два часа после, один раз в день', () => {
    expect(briefDue('08:30', local(8, 29), null, true)).toBe(false);
    expect(briefDue('08:30', local(8, 30), null, true)).toBe(true);
    expect(briefDue('08:30:00', local(10, 29), null, true)).toBe(true);
    expect(briefDue('08:30', local(10, 30), null, true)).toBe(false); // окно прошло — не шлём устаревшее
    expect(briefDue('08:30', local(9, 0), '2026-10-07', true)).toBe(false); // уже было сегодня
    expect(briefDue('08:30', local(9, 0), '2026-10-06', true)).toBe(true);
    expect(briefDue(null, local(9, 0), null, true)).toBe(false);
  });

  it('в выходные — только если человек сам попросил', () => {
    expect(briefDue('09:00', local(9, 5, 6), null, true)).toBe(false);
    expect(briefDue('09:00', local(9, 5, 0), null, false)).toBe(true);
  });

  it('утро: только непустые разделы, по делу', () => {
    const text = morningText({
      meetings: [{ title: 'Планёрка', startsAt: '2026-10-07T07:00:00Z' }],
      overdue: [{ id: '12', title: 'Счёт поставщику', projectId: '1' }],
      dueToday: [],
      blocked: [],
      decisions: { approvals: 2, reviews: 0, shifts: 1 },
      unreadDms: [{ name: 'Глеб', count: 3 }],
    }, TZ)!;
    expect(text).toContain('Встречи (1): 10:00 Планёрка');
    expect(text).toContain('Просрочено (1): #12 Счёт поставщику');
    expect(text).toContain('Ждут вашего решения: 2 согласования, 1 просьба о переносе срока');
    expect(text).toContain('Глеб (3)');
    expect(text).not.toContain('Срок сегодня');
  });

  it('писать не о чем — сводки нет', () => {
    expect(morningText({ meetings: [], overdue: [], dueToday: [], blocked: [], decisions: { approvals: 0, reviews: 0, shifts: 0 }, unreadDms: [] }, TZ)).toBeNull();
    expect(eveningText({ done: [], shifted: 0, blocked: [], tomorrow: [], meetingsTomorrow: 0 })).toBeNull();
  });

  it('вечер: сделано, перенесено, завтра; длинный список сворачивается', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1), title: `Задача ${i + 1}`, projectId: '1' }));
    const text = eveningText({ done: many, shifted: 2, blocked: [], tomorrow: many.slice(0, 1), meetingsTomorrow: 3 })!;
    expect(text).toContain('Завершено (5): #1 Задача 1; #2 Задача 2; #3 Задача 3 и ещё 2');
    expect(text).toContain('Перенесено сроков: 2');
    expect(text).toContain('Завтра: 1 задача со сроком (#1 Задача 1), 3 встречи');
  });
});
