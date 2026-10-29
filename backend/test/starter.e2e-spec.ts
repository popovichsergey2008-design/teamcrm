import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';

/**
 * Qevo-бот при первом входе (#4620): три ответа → проект с этапами по варианту А/Б
 * и двумя примерами задач на самом человеке в первой колонке.
 */
describe('Первый проект от Qevo-бота (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
  });
  afterAll(async () => { await app?.close(); });

  async function owner() {
    const o = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Старт', email: `start_${uniq()}@t.test`, password: 'Test-pass-2026', fullName: 'Борис' }).expect(201)).body.data;
    return { O: H(o.accessToken), userId: String(o.user.id) };
  }

  it('вариант Б «с командой»: Бэклог / В работе / На проверке / Готово, два примера в «Бэклог»', async () => {
    const { O, userId } = await owner();
    const r = (await http$.post('/api/onboarding/starter').set(O)
      .send({ sphere: 'business', name: 'Текущие задачи команды', team: true }).expect(201)).body.data;
    expect(r.columns.map((c: any) => c.name)).toEqual(['Бэклог', 'В работе', 'На проверке', 'Готово']);
    const board = (await http$.get(`/api/projects/${r.projectId}/board`).set(O).expect(200)).body.data;
    expect(board.project.name).toBe('Текущие задачи команды');
    expect(board.columns[0].tasks).toHaveLength(2);
    expect(board.columns[0].tasks.every((t: any) => String(t.assignee_id ?? t.assigneeId) === userId)).toBe(true);
  });

  it('вариант А «один»: Сделать / В работе / Готово; ответ словами понимается', async () => {
    const { O } = await owner();
    const r = (await http$.post('/api/onboarding/starter').set(O)
      .send({ sphere: 'personal', name: 'Мои задачи на неделю', team: false }).expect(201)).body.data;
    expect(r.columns.map((c: any) => c.name)).toEqual(['Сделать', 'В работе', 'Готово']);
    expect((await http$.post('/api/onboarding/starter/answer').set(O).send({ step: 'sphere', text: 'стройка и ремонт' }).expect(201)).body.data)
      .toEqual({ sphere: 'services' });
    expect((await http$.post('/api/onboarding/starter/answer').set(O).send({ step: 'team', text: 'пока один' }).expect(201)).body.data)
      .toEqual({ team: false });
    await http$.post('/api/onboarding/starter').set(O).send({ sphere: 'nope', name: 'X', team: false }).expect(400);
  });

  it('#4632: «Назад» и новое название — тот же проект переименован, второго нет', async () => {
    const { O } = await owner();
    const first = (await http$.post('/api/onboarding/starter').set(O)
      .send({ sphere: 'business', name: 'Альфа', team: false }).expect(201)).body.data;
    const again = (await http$.post('/api/onboarding/starter').set(O)
      .send({ sphere: 'business', name: 'Альфабет', team: true, projectId: first.projectId }).expect(201)).body.data;
    expect(again.projectId).toBe(first.projectId);
    expect(again.name).toBe('Альфабет');
    expect(again.columns.map((c: any) => c.name)).toEqual(['Бэклог', 'В работе', 'На проверке', 'Готово']);
    const list = (await http$.get('/api/projects').set(O).expect(200)).body.data;
    const mine = (Array.isArray(list) ? list : list.items ?? []).filter((p: any) => /Альфа/.test(p.name));
    expect(mine).toHaveLength(1);
    const board = (await http$.get(`/api/projects/${first.projectId}/board`).set(O).expect(200)).body.data;
    // примеры не задвоились
    expect(board.columns.reduce((n: number, c: any) => n + c.tasks.length, 0)).toBe(2);
    // чужой или несуществующий проект — 404, а не новый
    await http$.post('/api/onboarding/starter').set(O).send({ sphere: 'it', name: 'X', team: false, projectId: '999999999' }).expect(404);
  });
});
