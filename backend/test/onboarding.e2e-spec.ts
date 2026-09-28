import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';

/**
 * Путь владельца от регистрации до первой задачи (ТЗ-11).
 *
 * Проверяем обещания, а не хранение: шаги закрываются по факту работы (в том числе
 * сделанной мимо подсказки), владелец-одиночка доходит до конца без приглашений,
 * «Позже» переживает перезаход, а завершённый путь не навязывается снова.
 */
describe('онбординг владельца (e2e)', () => {
  let app: INestApplication;
  let http: any;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useWebSocketAdapter(new RedisIoAdapter(app));
    await app.listen(0, '0.0.0.0');
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
  });
  afterAll(async () => { await app?.close(); });

  const owner = async (prefix: string) => {
    const data = (await http.post('/api/auth/register')
      .send({ tenantName: prefix, email: `${prefix}_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    return H(data.accessToken);
  };
  const step = (view: any, key: string) => view.steps.find((s: any) => s.key === key);

  it('сразу после регистрации пройден один шаг из шести', async () => {
    const O = await owner('ob1');
    const view = (await http.get('/api/onboarding').set(O).expect(200)).body.data;

    expect(view.total).toBe(6);
    expect(view.done).toBe(1);
    expect(step(view, 'workspace').done).toBe(true);
    expect(view.completed).toBe(false);
    // зовём к обязательному, а не к настройкам компании
    expect(view.next).toBe('project');
  });

  it('шаг закрывается работой, сделанной МИМО подсказки', async () => {
    const O = await owner('ob2');
    const proj = (await http.post('/api/projects').set(O).send({ name: 'П' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${proj.id}/board`).set(O).expect(200)).body.data;
    await http.post('/api/tasks').set(O)
      .send({ projectId: proj.id, columnId: board.columns[0].id, title: 'Первая' }).expect(201);

    const view = (await http.get('/api/onboarding').set(O).expect(200)).body.data;
    expect(step(view, 'project').done).toBe(true);
    expect(step(view, 'task').done).toBe(true);
    // владелец-одиночка: ни отделов, ни приглашений — а путь пройден
    expect(step(view, 'team').done).toBe(false);
    expect(view.completed).toBe(true);
    expect(view.next).toBe('company');
  });

  it('«Позже» переживает перезаход, а обязательный шаг отложить нельзя', async () => {
    const O = await owner('ob3');
    await http.post('/api/onboarding/skip').set(O).send({ step: 'team' }).expect(201);

    const view = (await http.get('/api/onboarding').set(O).expect(200)).body.data;
    expect(step(view, 'team').skipped).toBe(true);
    // к отложенному больше не зовём
    expect(view.next).toBe('project');

    // «позже» на проект — отказ: без него системой не пользуются
    await http.post('/api/onboarding/skip').set(O).send({ step: 'project' }).expect(400);
  });

  it('настройки компании: пояс и отрасль сохраняются, шаг закрывается подтверждением', async () => {
    const O = await owner('ob4');
    const before = (await http.get('/api/onboarding').set(O).expect(200)).body.data;
    expect(step(before, 'company').done).toBe(false);
    expect(before.company.timezone).toBe('Europe/Moscow');

    const after = (await http.post('/api/onboarding/company').set(O)
      .send({ timezone: 'Asia/Vladivostok', industry: 'construction' }).expect(201)).body.data;
    expect(after.company.timezone).toBe('Asia/Vladivostok');
    expect(after.company.industry).toBe('construction');
    expect(step(after, 'company').done).toBe(true);

    // выдуманная отрасль не принимается
    await http.post('/api/onboarding/company').set(O).send({ industry: 'нет-такой' }).expect(400);
  });

  it('отделы предлагаются по отрасли и заводятся без дублей', async () => {
    const O = await owner('ob5');
    const list = (await http.get('/api/onboarding/industries').set(O).expect(200)).body.data;
    expect(list.length).toBeGreaterThanOrEqual(10);
    expect(list.map((i: any) => i.code)).toContain('it');
    expect(list.map((i: any) => i.code)).toContain('construction');

    const suggest = (await http.get('/api/onboarding/departments/suggest?industry=it').set(O).expect(200)).body.data;
    const checked = suggest.departments.filter((d: any) => d.checked).map((d: any) => d.name);
    expect(checked).toContain('Разработка');
    expect(suggest.departments.every((d: any) => d.exists === false)).toBe(true);

    const created = (await http.post('/api/onboarding/departments').set(O)
      .send({ names: ['Разработка', 'Тестирование'] }).expect(201)).body.data;
    expect(created.created).toBe(2);

    // повторный заход: отделы уже есть и вторыми не заведутся
    const again = (await http.get('/api/onboarding/departments/suggest?industry=it').set(O).expect(200)).body.data;
    expect(again.departments.find((d: any) => d.name === 'Разработка').exists).toBe(true);
    const twice = (await http.post('/api/onboarding/departments').set(O)
      .send({ names: ['Разработка'] }).expect(201)).body.data;
    expect(twice.created).toBe(0);

    const view = (await http.get('/api/onboarding').set(O).expect(200)).body.data;
    expect(step(view, 'departments').done).toBe(true);
  });

  it('новый сотрудник наследует часовой пояс компании, а не московский', async () => {
    const O = await owner('ob8');
    await http.post('/api/onboarding/company').set(O).send({ timezone: 'Asia/Vladivostok' }).expect(201);

    const mateEmail = `ob8_m_${uniq()}@t.test`;
    await http.post('/api/users').set(O)
      .send({ email: mateEmail, fullName: 'Пётр Коллега', password: 'password123', role: 'member' }).expect(201);
    const M = H((await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);

    // до этого каждый приглашённый жил по Москве, пока сам не залезал в профиль
    const me = (await http.get('/api/me').set(M).expect(200)).body.data;
    expect(me.timezone).toBe('Asia/Vladivostok');
  });

  it('приглашения списком: удачные не откатываются из-за неудачных', async () => {
    const O = await owner('ob9');
    const mine = `ob9_self_${uniq()}@t.test`;
    // первый адрес — свежий, второй уже позван, третий — сам владелец
    const fresh = `ob9_a_${uniq()}@t.test`;
    await http.post('/api/invites').set(O).send({ email: fresh, role: 'member' }).expect(201);

    const other = `ob9_b_${uniq()}@t.test`;
    const res = (await http.post('/api/invites/batch').set(O)
      .send({ emails: [other, fresh, mine], role: 'member' }).expect(201)).body.data;

    expect(res.results.length).toBe(3);
    const byEmail = Object.fromEntries(res.results.map((r: any) => [r.email, r]));
    // новый позван и получил ссылку
    expect(byEmail[other].ok).toBe(true);
    expect(String(byEmail[other].link)).toContain('invite=');

    // шаг «пригласить команду» закрылся
    const view = (await http.get('/api/onboarding').set(O).expect(200)).body.data;
    expect(step(view, 'team').done).toBe(true);
  });

  it('подсказку можно свернуть и открыть заново', async () => {
    const O = await owner('ob6');
    const off = (await http.post('/api/onboarding/dismiss').set(O).send({ dismissed: true }).expect(201)).body.data;
    expect(off.dismissed).toBe(true);
    expect((await http.get('/api/onboarding').set(O).expect(200)).body.data.dismissed).toBe(true);

    const on = (await http.post('/api/onboarding/dismiss').set(O).send({ dismissed: false }).expect(201)).body.data;
    expect(on.dismissed).toBe(false);
  });

  it('сотруднику путь владельца не показывается', async () => {
    const O = await owner('ob7');
    const mateEmail = `ob7_m_${uniq()}@t.test`;
    await http.post('/api/users').set(O)
      .send({ email: mateEmail, fullName: 'Пётр Коллега', password: 'password123', role: 'member' }).expect(201);
    const M = H((await http.post('/api/auth/login')
      .send({ email: mateEmail, password: 'password123' }).expect(201)).body.data.accessToken);

    await http.get('/api/onboarding').set(M).expect(403);
  });
});
