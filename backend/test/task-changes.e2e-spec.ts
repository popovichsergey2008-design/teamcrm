import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';

/** ТЗ-32: счётчики изменений по задачам в «Пульсе» — по журналу переходов. */
describe('Изменения по задачам (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let db: DbService;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    db = app.get(DbService);
  });
  afterAll(async () => { await app?.close(); });

  it('в тест → возврат → в тест → готово → переоткрыто; автор ≠ исполнитель; список и CSV', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'CH', email: `ch_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей Владелец' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);
    const gleb = (await http$.post('/api/users').set(O)
      .send({ email: `ch_g_${uniq()}@t.test`, fullName: 'Глеб Исполнитель', password: 'password123', role: 'member' }).expect(201)).body.data;
    const project = (await http$.post('/api/projects').set(O).send({ name: 'Изменения' }).expect(201)).body.data;
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
    const col = (name: string) => String(board.columns.find((c: any) => c.name === name).id);
    const task = (await http$.post('/api/tasks').set(O)
      .send({ projectId: project.id, columnId: col('В работе'), title: 'Проверить форму', assigneeId: gleb.id, confirmWorkload: true }).expect(201)).body.data;
    const move = async (name: string) => {
      await http$.post(`/api/tasks/${task.id}/move`).set(O).send({ columnId: col(name), position: 0, confirmGate: true }).expect(201);
      await wait(3200); // шаги одного переноса склеиваются в пределах 3 секунд — разделяем
    };
    await move('На тестировании');
    await move('В работе');
    await move('На тестировании');
    await move('Готово');
    await move('В работе');

    const today = new Date().toISOString().slice(0, 10);
    const q = `from=${today}&to=${today}&tz=UTC`;
    const s = (await http$.get(`/api/radar/changes?${q}`).set(O).expect(200)).body.data;
    expect(s.totals).toMatchObject({ entered_testing: 2, returned_to_work: 1, moved_to_done: 1, reopened: 1 });
    expect(s.unique.entered_testing).toBe(1);
    // двигал владелец, задача — Глеба
    expect(s.users[0].name).toBe('Сергей Владелец');
    const byAssignee = (await http$.get(`/api/radar/changes?${q}&by=assignee`).set(O).expect(200)).body.data;
    expect(byAssignee.users[0].name).toBe('Глеб Исполнитель');
    expect(byAssignee.users[0].counts.entered_testing).toBe(2);

    const list = (await http$.get(`/api/radar/changes/events?${q}&kind=entered_testing`).set(O).expect(200)).body.data;
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({ title: 'Проверить форму', projectName: 'Изменения', assigneeName: 'Глеб Исполнитель', source: 'MANUAL' });

    const csv = await http$.get(`/api/radar/changes/export?${q}`).set(O).expect(200);
    expect(String(csv.text)).toContain('Проверить форму');

    expect(s.digest).toContain('ушли в тест');

    // смена исполнителя и срока — отдельные счётчики (§2), автор дописан
    await http$.patch(`/api/tasks/${task.id}`).set(O).send({ priority: 'high' }).expect(200);
    const f = (await http$.get(`/api/radar/changes?${q}`).set(O).expect(200)).body.data;
    expect(f.fields.priority).toBe(1);
    const pr = (await http$.get(`/api/radar/changes/events?${q}&kind=field:priority`).set(O).expect(200)).body.data;
    expect(pr.items[0]).toMatchObject({ toLabel: 'высокий', actorName: 'Сергей Владелец' });

    // без права на «Пульс» — нельзя
    const login = (await http$.post('/api/auth/login').send({ email: gleb.email, password: 'password123' }).expect(201)).body.data;
    await http$.get(`/api/radar/changes?${q}`).set(H(login.accessToken)).expect(403);

    // перестановка в той же колонке — не переход; склейка: шаги одного переноса — одна запись
    const n = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM task_status_transitions WHERE task_id = $1`, [task.id]);
    expect(n?.n).toBe(5);
  }, 60_000);
});
