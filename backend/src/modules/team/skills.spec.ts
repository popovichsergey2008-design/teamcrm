import { DEPARTMENT_SKILLS, isDepartment, isSkill, skillFits, skillsCatalog, SKILLS } from './skills';

/** Справочник направлений (ТЗ-10, этап 3): закрытый список и честное совпадение. */
describe('skills', () => {
  it('принимает только известные значения', () => {
    expect(isSkill('backend')).toBe(true);
    expect(isSkill('фронтенд')).toBe(false);
    expect(isSkill('fullstack-middle+')).toBe(false);
    expect(isDepartment('development')).toBe(true);
    expect(isDepartment('marketing')).toBe(false);
  });

  it('фулстек закрывает бэкенд и фронтенд, но не наоборот', () => {
    expect(skillFits(['fullstack'], 'backend')).toBe(true);
    expect(skillFits(['fullstack'], 'frontend')).toBe(true);
    expect(skillFits(['backend'], 'frontend')).toBe(false);
    expect(skillFits(['content'], 'backend')).toBe(false);
    // направление не задано — подходит любой: пусть решает человек
    expect(skillFits(['content'], null)).toBe(true);
  });

  it('фулстек не выдаёт себя за контент: это другой отдел', () => {
    expect(skillFits(['fullstack'], 'content')).toBe(false);
  });

  it('справочник для промпта содержит отделы с направлениями и без «не определён»', () => {
    const c = skillsCatalog();
    expect(c.departments.map((d) => d.code)).toEqual(['development', 'content']);
    expect(c.departments[0].specializations).toEqual(DEPARTMENT_SKILLS.development);
    expect(Object.keys(c.labels)).toHaveLength(SKILLS.length);
  });
});
