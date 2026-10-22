import { StarterService } from './starter.service';
import { SOLO_COLUMNS, starterPlan, TEAM_COLUMNS } from './starter-plan';

/**
 * #4632: в Qevo-боте можно вернуться «Назад» и поменять ответ. Проект уже создан —
 * он правится (имя, колонки), а второй не появляется и примеры не дублируются.
 */
describe('StarterService: «Назад» без дублей (#4632)', () => {
  function setup(cols: string[], project: { name: string; description: string }) {
    let columns = cols.map((name, i) => ({ id: String(i + 1), name }));
    const projects = {
      create: jest.fn(async () => ({ id: 77, name: 'Новый' })),
      getOrThrow: jest.fn(async () => ({ id: '77', ...project })),
      update: jest.fn(async () => ({})),
      renameColumn: jest.fn(async (_t: string, _p: string, id: string, name: string) => {
        columns = columns.map((c) => (c.id === id ? { ...c, name } : c));
      }),
      addColumn: jest.fn(async (_t: string, _p: string, name: string) => { columns = [...columns, { id: String(columns.length + 10), name }]; }),
      deleteColumn: jest.fn(async (_t: string, _p: string, id: string) => { columns = columns.filter((c) => c.id !== id); }),
    };
    const repo = { listColumns: jest.fn(async () => columns) };
    const tasks = { create: jest.fn(async () => ({ id: 1 })) };
    const svc = new StarterService(projects as never, repo as never, tasks as never);
    return { svc, projects, tasks };
  }
  const a = { tenantId: 't1', userId: 'u1', role: 'owner' };

  it('новое название при уже созданном проекте — переименование, а не второй проект', async () => {
    const plan = starterPlan({ sphere: 'business', name: 'Альфа', team: false });
    const { svc, projects, tasks } = setup(SOLO_COLUMNS, { name: 'Альфа', description: plan.description });
    const r = await svc.create(a, { sphere: 'business', name: 'Альфабет', team: false, projectId: '77' });
    expect(projects.create).not.toHaveBeenCalled();
    expect(tasks.create).not.toHaveBeenCalled();
    expect(projects.update).toHaveBeenCalledWith('t1', '77', { userId: 'u1', role: 'owner' }, expect.objectContaining({ name: 'Альфабет' }));
    expect(r).toMatchObject({ projectId: '77', name: 'Альфабет', revised: true, taskIds: [] });
  });

  it('передумал «один → с командой» — колонки перестроены на месте', async () => {
    const { svc, projects } = setup(SOLO_COLUMNS, { name: 'Альфабет', description: 'Своё описание' });
    const r = await svc.create(a, { sphere: 'business', name: 'Альфабет', team: true, projectId: '77' });
    expect(projects.create).not.toHaveBeenCalled();
    // имя то же, описание человека не трогаем
    expect(projects.update).not.toHaveBeenCalled();
    expect(r.columns.map((c) => c.name)).toEqual(TEAM_COLUMNS);
  });

  it('без projectId — обычное создание с примерами', async () => {
    const { svc, projects, tasks } = setup(SOLO_COLUMNS, { name: '', description: '' });
    const r = await svc.create(a, { sphere: 'it', name: 'Сайт', team: false });
    expect(projects.create).toHaveBeenCalledTimes(1);
    expect(tasks.create).toHaveBeenCalledTimes(2);
    expect(r.revised).toBe(false);
  });
});
