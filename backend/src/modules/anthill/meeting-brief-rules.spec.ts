import { meetingBriefText, weekAuditText } from './meeting-brief-rules';

describe('meeting-brief-rules', () => {
  const base = {
    title: 'Созвон с Acme', startsAt: new Date(), participants: ['Сергей', 'Глеб'], client: null, description: null,
    decisions: [], overdue: [], approvals: [], review: [],
  };

  it('без фактов справки нет', () => {
    expect(meetingBriefText(base, 30)).toBeNull();
  });

  it('факты по делу: клиент, цель, прошлые решения, просрочки', () => {
    const text = meetingBriefText({
      ...base, client: 'Acme', description: 'Обсудить бюджет на Q4',
      decisions: ['Глеб готовит смету'], overdue: [{ title: 'Смета Q4', assignee: 'Глеб', days: 2 }],
    }, 30)!;
    expect(text).toContain('Через 30 минут — «Созвон с Acme». Участники: Сергей, Глеб');
    expect(text).toContain('Клиент: Acme');
    expect(text).toContain('Цель: Обсудить бюджет на Q4');
    expect(text).toContain('Прошлый раз решили: Глеб готовит смету');
    expect(text).toContain('Смета Q4 (Глеб, 2 дн.)');
    expect(meetingBriefText({ ...base, client: 'X' }, 1)).toContain('Через 1 минуту');
  });

  it('аудит недели: доли и советы по порогам', () => {
    const text = weekAuditText({ workHours: 40, meetingMinutes: 18 * 60, deepMinutes: 120, trackedMinutes: 0, closed: 7, overdueNow: 3 })!;
    expect(text).toContain('Встречи: 18 ч (45% рабочего времени)');
    expect(text).toContain('Глубокая работа: 2 ч');
    expect(text).toContain('Закрыто задач: 7, просрочено сейчас: 3');
    expect(text).toContain('больше 40% недели');
    expect(text).toContain('меньше 4 часов');
    expect(text).not.toContain('трекере');
    expect(weekAuditText({ workHours: 40, meetingMinutes: 0, deepMinutes: 0, trackedMinutes: 0, closed: 0, overdueNow: 0 })).toBeNull();
  });

  it('спокойная неделя — без советов', () => {
    const text = weekAuditText({ workHours: 40, meetingMinutes: 300, deepMinutes: 600, trackedMinutes: 90, closed: 4, overdueNow: 0 })!;
    expect(text).toContain('Встречи: 5 ч (13% рабочего времени)');
    expect(text).toContain('Учтено в трекере: 1,5 ч');
    expect(text).not.toContain('Совет');
  });
});
