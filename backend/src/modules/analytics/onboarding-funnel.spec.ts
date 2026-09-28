import {
  durationsOf, FUNNEL_STEPS, median, stepsOf, summarize, TenantMilestones,
} from './onboarding-funnel';

const HOUR = 3_600_000;
const start = new Date('2026-09-01T09:00:00.000Z');

const org = (over: Partial<TenantMilestones> = {}): TenantMilestones => ({
  tenantId: '1', name: 'Компания', createdAt: start,
  companyAt: null, telegramAt: null, departmentAt: null, inviteAt: null,
  memberAt: null, projectAt: null, taskAt: null, completedAt: null,
  invitesSent: 0, invitesAccepted: 0, voiceJobs: 0,
  ...over,
});

describe('воронка онбординга', () => {
  it('у только что заведённой организации пройден ровно один шаг', () => {
    const steps = stepsOf(org());
    expect(steps.workspace).toEqual(start);
    expect(FUNNEL_STEPS.filter((k) => steps[k]).length).toBe(1);
  });

  it('шаги считаются каждый сам по себе, а не через предыдущий', () => {
    // Проект без единого отдела — обычное дело, и воронка не должна это прятать.
    const s = summarize([org({ projectAt: new Date(start.getTime() + HOUR) })]);
    const by = Object.fromEntries(s.steps.map((x) => [x.key, x.count]));
    expect(by.project).toBe(1);
    expect(by.department).toBe(0);
  });

  it('главная метрика — время до первой задачи', () => {
    const d = durationsOf(org({
      projectAt: new Date(start.getTime() + HOUR),
      taskAt: new Date(start.getTime() + 3 * HOUR),
    }));
    expect(d.toProject).toBe(HOUR);
    expect(d.toTask).toBe(3 * HOUR);
    // Первая польза = первая задача: пустой проект работу не меняет.
    expect(d.toValue).toBe(d.toTask);
  });

  it('чего не случилось, то и не мерим: null, а не ноль', () => {
    const d = durationsOf(org());
    expect(d.toTask).toBeNull();
    expect(d.toCollaboration).toBeNull();
    // Ноль означал бы «успели мгновенно» и тянул бы медиану вниз.
    expect(Object.values(d).every((v) => v === null)).toBe(true);
  });

  it('событие раньше создания организации не мерим: это сбитые часы, а не скорость', () => {
    const d = durationsOf(org({ taskAt: new Date(start.getTime() - HOUR) }));
    expect(d.toTask).toBeNull();
  });

  it('медиана не ведётся на одного заснувшего клиента', () => {
    const rows = [1, 2, 3, 4, 5000].map((h) => org({ taskAt: new Date(start.getTime() + h * HOUR) }));
    const s = summarize(rows);
    expect(s.medians.toTask).toBe(3 * HOUR);
  });

  it('медиана чётного числа значений — середина между серединами', () => {
    expect(median([2, 4, 6, 8])).toBe(5);
    expect(median([])).toBeNull();
  });

  it('доля дошедших до конца и доля принятых приглашений считаются отдельно', () => {
    const s = summarize([
      org({ completedAt: new Date(), invitesSent: 4, invitesAccepted: 1 }),
      org({ invitesSent: 0, invitesAccepted: 0 }),
    ]);
    expect(s.completionRate).toBe(0.5);
    // Считаем по приглашениям, а не по организациям: 1 из 4.
    expect(s.inviteAcceptance).toBe(0.25);
  });

  it('без приглашений доля не ноль, а «не о чем говорить»', () => {
    // Ноль читался бы как «приглашают, но никто не приходит» — это разные беды.
    expect(summarize([org()]).inviteAcceptance).toBeNull();
  });

  it('пустой список не роняет свод и не делит на ноль', () => {
    const s = summarize([]);
    expect(s.tenants).toBe(0);
    expect(s.completionRate).toBe(0);
    expect(s.voiceAdoption).toBe(0);
    expect(s.steps.every((x) => x.count === 0 && x.share === 0)).toBe(true);
  });

  it('голос считаем по организациям, а не по надиктовкам', () => {
    const s = summarize([org({ voiceJobs: 40 }), org({ voiceJobs: 0 })]);
    expect(s.voiceAdoption).toBe(0.5);
  });
});
