import { resolveProject, spokenProjectName } from './project-resolver';

const P = [
  { id: '1', name: 'Заказчик А', aliases: ['Alpha', 'Клиент Альфа'] },
  { id: '2', name: 'Новый сайт' },
  { id: '3', name: 'Мобильное приложение', clientId: '77', clientName: 'Acme' },
  { id: '4', name: 'Лендинг Acme', clientId: '77', clientName: 'Acme' },
  { id: '5', name: 'Бэкофис', clientId: '88', clientName: 'Ромашка' },
];

describe('определитель проекта (ТЗ-31)', () => {
  it('явное название → HIGH (§10)', () => {
    const r = resolveProject({ text: 'В проекте Заказчик А поставь Глебу задачу проверить форму оплаты до пятницы', projects: P });
    expect(r).toMatchObject({ projectId: '1', level: 'HIGH', resolution: 'AUTO_HIGH_CONFIDENCE' });
    expect(r.reasonCodes[0]).toBe('EXPLICIT_PROJECT_MENTION');
  });

  it('другое название (алиас) узнаётся (§24)', () => {
    expect(resolveProject({ text: 'для альфы поправить кнопку — Alpha', projects: P }).projectId).toBe('1');
  });

  it('создание из проекта / чат проекта → HIGH (§11–12)', () => {
    expect(resolveProject({ text: 'проверить мобильную версию', projects: P, sourceProjectId: '2' }).level).toBe('HIGH');
    expect(resolveProject({ text: 'проверить мобильную версию', projects: P, chatProjectId: '2' }).projectId).toBe('2');
  });

  it('открытый экран — сильный, но не HIGH в одиночку', () => {
    const r = resolveProject({ text: 'проверить мобильную версию', projects: P, routeProjectId: '2' });
    expect(r).toMatchObject({ projectId: '2', level: 'MEDIUM' });
  });

  it('клиент с одним проектом → HIGH; с несколькими → варианты (§14)', () => {
    expect(resolveProject({ text: 'Для Ромашки обновить КП', projects: P }).projectId).toBe('5');
    const r = resolveProject({ text: 'Для Acme обновить коммерческое предложение', projects: P });
    expect(r.level).toBe('MEDIUM');
    expect([r.projectId, ...r.alternatives.map((a) => a.projectId)].sort()).toEqual(['3', '4']);
  });

  it('личная переписка: общий проект двоих → MEDIUM с подстановкой, недавность — довесок', () => {
    const r = resolveProject({
      text: 'поправь кнопку оплаты', projects: P,
      people: [{ userId: 'a', projectIds: ['2', '3'] }, { userId: 'b', projectIds: ['2'] }],
      recent: { '2': 2 },
    });
    expect(r).toMatchObject({ projectId: '2', level: 'MEDIUM', resolution: 'SUGGESTED' });
  });

  it('только недавность — проект не выбирается (§38)', () => {
    const r = resolveProject({ text: 'сделать отчёт', projects: P, recent: { '2': 10 } });
    expect(r).toMatchObject({ projectId: null, level: 'LOW', resolution: 'NEEDS_CHOICE' });
    expect(r.alternatives[0].projectId).toBe('2');
  });

  it('ничего не известно → LOW, проекта нет', () => {
    expect(resolveProject({ text: 'сделать отчёт', projects: P })).toMatchObject({ projectId: null, level: 'LOW' });
  });

  it('назван несуществующий проект → NOT_FOUND, доску молча не подставляем (§20)', () => {
    const r = resolveProject({ text: 'Сделай задачу по проекту Tesla', projects: P, routeProjectId: '2' });
    expect(r.resolution).toBe('NOT_FOUND');
    expect(r.notFoundName).toBe('Tesla');
    expect(r.level).not.toBe('HIGH');
  });

  it('чат одного проекта, а в тексте назван другой — побеждает названный', () => {
    const r = resolveProject({ text: 'это по проекту Новый сайт', projects: P, chatProjectId: '1' });
    expect(r).toMatchObject({ projectId: '2', level: 'HIGH' });
    expect(r.alternatives[0].projectId).toBe('1');
  });

  it('только доступные: чужой проект из сигнала игнорируется (§23)', () => {
    const r = resolveProject({ text: 'x', projects: P, sourceProjectId: '999' });
    expect(r.projectId).toBeNull();
  });

  it('единственный проект в компании → HIGH', () => {
    expect(resolveProject({ text: 'x', projects: [P[1]] })).toMatchObject({ projectId: '2', level: 'HIGH' });
  });

  it('имя проекта из фразы', () => {
    expect(spokenProjectName('Сделай задачу по проекту Tesla')).toBe('Tesla');
    expect(spokenProjectName('в проекте Новый сайт поставь Глебу')).toBe('Новый сайт');
    expect(spokenProjectName('поставь Глебу задачу')).toBeNull();
    expect(spokenProjectName('по проекту Tesla обновить баннер')).toBe('Tesla');
  });
});
