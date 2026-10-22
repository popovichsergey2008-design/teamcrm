import { SOLO_COLUMNS, sphereFromText, starterPlan, TEAM_COLUMNS, teamFromText } from './starter-plan';

describe('первый проект от Qevo-бота (#4620)', () => {
  it('вариант А «Пока работаю один» — Сделать / В работе / Готово', () => {
    const p = starterPlan({ sphere: 'business', name: 'Текущие задачи команды', team: false });
    expect(p.columns).toEqual(['Сделать', 'В работе', 'Готово']);
    expect(p.columns).toEqual(SOLO_COLUMNS);
  });

  it('вариант Б «Работаю с командой» — Бэклог / В работе / На проверке / Готово', () => {
    const p = starterPlan({ sphere: 'it', name: 'Запуск нового проекта', team: true });
    expect(p.columns).toEqual(['Бэклог', 'В работе', 'На проверке', 'Готово']);
    expect(p.columns).toEqual(TEAM_COLUMNS);
  });

  it('два примера задач под каждую сферу, у сфер — разные', () => {
    const seen = new Set<string>();
    for (const sphere of ['business', 'it', 'services', 'personal', 'custom'] as const) {
      const p = starterPlan({ sphere, name: 'X', team: false });
      expect(p.examples).toHaveLength(2);
      for (const e of p.examples) { expect(e.length).toBeGreaterThan(5); expect(seen.has(e)).toBe(false); seen.add(e); }
    }
  });

  it('имя — как назвал человек, пустое — запасное; описание годится определителю проекта', () => {
    expect(starterPlan({ sphere: 'personal', name: '  Мои   задачи на неделю ', team: false }).name).toBe('Мои задачи на неделю');
    expect(starterPlan({ sphere: 'personal', name: '   ', team: false }).name).toBe('Мой первый проект');
    const p = starterPlan({ sphere: 'custom', sphereText: 'кофейня у дома', name: 'Кофейня', team: true });
    expect(p.description).toContain('кофейня у дома');
    expect(p.description.length).toBeGreaterThanOrEqual(10);
  });

  it('незнакомая сфера — как «своя»', () => {
    expect(starterPlan({ sphere: 'zzz' as never, name: 'A', team: false }).examples)
      .toEqual(starterPlan({ sphere: 'custom', name: 'A', team: false }).examples);
  });

  it('сфера из голоса или текста', () => {
    expect(sphereFromText('Для маркетинга и сайта')).toBe('it');
    expect(sphereFromText('айти-стартап')).toBe('it');
    expect(sphereFromText('итоги месяца')).not.toBe('it');
    expect(sphereFromText('У нас стройка и ремонт квартир')).toBe('services');
    expect(sphereFromText('Для себя, личные дела')).toBe('personal');
    expect(sphereFromText('Управлять командой в компании')).toBe('business');
    expect(sphereFromText('кофейня')).toBe('custom');
  });

  it('один или с командой — из ответа словами', () => {
    expect(teamFromText('Пока работаю один')).toBe(false);
    expect(teamFromText('сам')).toBe(false);
    expect(teamFromText('с командой из пяти человек')).toBe(true);
    expect(teamFromText('вместе с коллегами')).toBe(true);
    expect(teamFromText('не знаю')).toBeNull();
  });
});
