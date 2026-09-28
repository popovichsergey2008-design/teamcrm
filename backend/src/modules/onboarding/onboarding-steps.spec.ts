import { buildSteps, isComplete, nextStep, OnboardingFacts, progress } from './onboarding-steps';
import { industryByCode, INDUSTRIES, suggestedDepartments } from './industries';

const EMPTY: OnboardingFacts = {
  companyConfirmed: false, departments: 0, teammates: 0, invites: 0, projects: 0, tasks: 0,
};

describe('путь владельца: шаги и завершение', () => {
  it('сразу после регистрации пройден только первый шаг', () => {
    const steps = buildSteps(EMPTY);
    expect(progress(steps)).toEqual({ done: 1, total: 6 });
    expect(steps[0].key).toBe('workspace');
    expect(steps[0].done).toBe(true);
    expect(isComplete(steps)).toBe(false);
  });

  it('шаги считаются по ФАКТУ, а не по отметкам мастера', () => {
    // владелец создал проект и задачу сам, мимо подсказки
    const steps = buildSteps({ ...EMPTY, projects: 1, tasks: 2 });
    expect(steps.find((s) => s.key === 'project')?.done).toBe(true);
    expect(steps.find((s) => s.key === 'task')?.done).toBe(true);
    expect(isComplete(steps)).toBe(true);
  });

  it('владелец-одиночка завершает путь без приглашений и отделов', () => {
    const steps = buildSteps({ ...EMPTY, projects: 1, tasks: 1 });
    expect(steps.find((s) => s.key === 'team')?.done).toBe(false);
    expect(steps.find((s) => s.key === 'departments')?.done).toBe(false);
    // требование ТЗ: приглашение команды не блокирует завершение
    expect(isComplete(steps)).toBe(true);
  });

  it('«команду позвал» — это и отправленное приглашение, а не только пришедший коллега', () => {
    expect(buildSteps({ ...EMPTY, invites: 1 }).find((s) => s.key === 'team')?.done).toBe(true);
    expect(buildSteps({ ...EMPTY, teammates: 1 }).find((s) => s.key === 'team')?.done).toBe(true);
  });

  it('«Позже» гасит шаг, но сделанный шаг отложенным не считается', () => {
    const later = buildSteps(EMPTY, ['team']);
    expect(later.find((s) => s.key === 'team')?.skipped).toBe(true);

    // пригласил всё-таки — отметка «позже» больше ничего не значит
    const done = buildSteps({ ...EMPTY, invites: 1 }, ['team']);
    expect(done.find((s) => s.key === 'team')?.skipped).toBe(false);
    expect(done.find((s) => s.key === 'team')?.done).toBe(true);
  });

  it('зовём сначала к обязательному, отложенное не предлагаем', () => {
    // всё открыто — первым зовём к проекту, а не к настройкам компании
    expect(nextStep(buildSteps(EMPTY))?.key).toBe('project');
    // проект и задача есть — остаётся необязательное, по порядку
    expect(nextStep(buildSteps({ ...EMPTY, projects: 1, tasks: 1 }))?.key).toBe('company');
    // отложенное пропускаем
    expect(nextStep(buildSteps({ ...EMPTY, projects: 1, tasks: 1 }, ['company']))?.key).toBe('departments');
    // не осталось ничего — звать некуда
    const all = { companyConfirmed: true, departments: 1, teammates: 1, invites: 0, projects: 1, tasks: 1 };
    expect(nextStep(buildSteps(all))).toBeNull();
  });

  it('настройки компании считаются только по подтверждению', () => {
    // у пояса есть значение по умолчанию: «не трогал» от «оставил как есть» не отличить,
    // поэтому шаг закрывается явным подтверждением владельца
    expect(buildSteps(EMPTY).find((s) => s.key === 'company')?.done).toBe(false);
    expect(buildSteps({ ...EMPTY, companyConfirmed: true }).find((s) => s.key === 'company')?.done).toBe(true);
  });
});

describe('отрасли и предлагаемые отделы', () => {
  it('у каждой отрасли есть код, название и отделы, и коды не повторяются', () => {
    const codes = INDUSTRIES.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const industry of INDUSTRIES) {
      expect(industry.title.length).toBeGreaterThan(2);
      expect(industry.departments.length).toBeGreaterThanOrEqual(4);
      // в каждой отрасли есть что отметить заранее — иначе шаг бесполезен
      expect(industry.departments.some((d) => d.common)).toBe(true);
      // и есть что оставить на выбор — иначе это не предложение, а навязывание
      expect(industry.departments.some((d) => !d.common)).toBe(true);
    }
  });

  it('незнакомая отрасль — «Другое», а не пустой список', () => {
    expect(industryByCode('нет такой').code).toBe('other');
    expect(industryByCode(null).code).toBe('other');
    expect(suggestedDepartments(null).length).toBeGreaterThan(0);
  });

  it('предлагаем отмеченным только то, что есть почти у всех в отрасли', () => {
    const it = suggestedDepartments('it');
    expect(it).toContain('Разработка');
    expect(it).toContain('Тестирование');
    // DevOps есть не у каждой ИТ-компании — предлагаем, но не отмечаем
    expect(it).not.toContain('Эксплуатация и DevOps');

    const build = suggestedDepartments('construction');
    expect(build).toContain('Сметный отдел');
    expect(build).not.toContain('Разработка');
  });

  it('названия отделов внутри отрасли не повторяются', () => {
    for (const industry of INDUSTRIES) {
      const names = industry.departments.map((d) => d.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});
