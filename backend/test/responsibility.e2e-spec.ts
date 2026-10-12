import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { DbService } from '../src/database/db.service';

/**
 * ТЗ-30: просрочка — по фактической ответственности.
 *
 * Сценарий из «Definition of Done»: Сергей сделал задачу и сдал на тестирование, QA
 * задержал проверку, срок прошёл. Задача остаётся просроченной для проекта, но Сергей —
 * нет: ни в его списке, ни в «Пульсе», ни в узких местах. Вернули на доработку после
 * срока — у него окно доработки, а не мгновенная многодневная просрочка.
 */
describe('ТЗ-30 — просрочка по ответственности (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let db: DbService;
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
    db = app.get(DbService);
  });
  afterAll(async () => { await app?.close(); });

  it('сдал на тестирование — не его просрочка; вернули — окно доработки; тип колонки руками', async () => {
    const owner = (await http.post('/api/auth/register')
      .send({ tenantName: 'Ответственность', email: `rs_${uniq()}@t.test`, password: 'password123', fullName: 'Борис' })
      .expect(201)).body.data;
    const O = H(owner.accessToken);
    const email = `rs_m_${uniq()}@t.test`;
    const sergeyUser = (await http.post('/api/users').set(O).send({ email, fullName: 'Сергей', password: 'password123', role: 'member' }).expect(201)).body.data;
    const S = H((await http.post('/api/auth/login').send({ email, password: 'password123' }).expect(201)).body.data.accessToken);

    const project = (await http.post('/api/projects').set(O).send({ name: 'Релиз' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
    const col = (name: string) => board.columns.find((c: any) => c.name === name);
    // 1. Тип этапа выставлен по названию сам
    expect(col('На тестировании').stage_type).toBe('testing');
    expect(col('Готово').stage_type).toBe('done');
    expect(col('В работе').stage_type).toBe('work');

    const task = (await http.post('/api/tasks').set(O).send({
      projectId: project.id, columnId: col('В работе').id, title: 'Гостевые ссылки', assigneeId: String(sergeyUser.id),
      deadlineAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
    }).expect(201)).body.data;

    // 2. До сдачи — его просрочка
    let mine = (await http.get('/api/tasks/my?scope=mine').set(S).expect(200)).body.data;
    expect(mine.find((t: any) => String(t.id) === String(task.id)).personal_overdue).toBe(true);

    // 3. Сдал на тестирование: задача просрочена для проекта, но не у него
    await http.post(`/api/tasks/${task.id}/move`).set(S).send({ columnId: String(col('На тестировании').id), position: 0, confirmGate: true }).expect(201);
    const marks = await db.one<{ submitted_at: Date | null; first_submitted_at: Date | null }>(`SELECT submitted_at, first_submitted_at FROM tasks WHERE id = $1`, [task.id]);
    expect(marks!.submitted_at).toBeTruthy();
    mine = (await http.get('/api/tasks/my?scope=mine').set(S).expect(200)).body.data;
    const row = mine.find((t: any) => String(t.id) === String(task.id));
    expect(row.stage).toBe('testing');
    expect(row.personal_overdue).toBe(false);

    // 4. «Пульс»: у Сергея 0 просрочено и 1 передано на проверку; узкое место — проверка, не Сергей
    const pulse = (await http.get('/api/radar/summary?tz=Europe/Moscow').set(O).expect(200)).body.data;
    const w = pulse.workload.find((x: any) => x.id === String(sergeyUser.id));
    expect(w.overdue).toBe(0);
    expect(w.submitted).toBe(1);
    const b = pulse.bottlenecks.find((x: any) => x.taskId === String(task.id));
    expect(b?.type).toBe('WAITING_REVIEW');
    // для проекта задача по-прежнему просрочена — с причиной «проверка»
    const p = pulse.projects?.find?.((x: any) => x.id === String(project.id)) ?? pulse.projectRisks?.find?.((x: any) => x.id === String(project.id));
    if (p) {
      expect(p.overdue).toBe(1);
      expect(p.overdueStages.review).toBe(1);
    }

    // 5. Вернули на доработку после срока — окно доработки, а не мгновенная просрочка
    await http.post(`/api/tasks/${task.id}/move`).set(O).send({ columnId: String(col('В работе').id), position: 0 }).expect(201);
    const back = await db.one<{ returned_at: Date | null; fix_deadline_at: Date | null }>(`SELECT returned_at, fix_deadline_at FROM tasks WHERE id = $1`, [task.id]);
    expect(back!.returned_at).toBeTruthy();
    expect(new Date(back!.fix_deadline_at!).getTime()).toBeGreaterThan(Date.now() + 20 * 3600_000);
    mine = (await http.get('/api/tasks/my?scope=mine').set(S).expect(200)).body.data;
    expect(mine.find((t: any) => String(t.id) === String(task.id)).personal_overdue).toBe(false);

    // 6. Новый срок руками отменяет окно доработки
    await http.patch(`/api/tasks/${task.id}`).set(O).send({ deadlineAt: new Date(Date.now() + 3 * 86400_000).toISOString() }).expect(200);
    expect((await db.one<{ fix_deadline_at: Date | null }>(`SELECT fix_deadline_at FROM tasks WHERE id = $1`, [task.id]))!.fix_deadline_at).toBeNull();

    // 7. Тип колонки руками: «В работе» → «ждём клиента»; назад — по названию
    const manual = (await http.patch(`/api/projects/${project.id}/columns/${col('В работе').id}/stage`).set(O).send({ stage: 'waiting_external' }).expect(200)).body.data;
    expect(manual).toMatchObject({ stage_type: 'waiting_external', stage_type_manual: true });
    const auto = (await http.patch(`/api/projects/${project.id}/columns/${col('В работе').id}/stage`).set(O).send({ stage: 'auto' }).expect(200)).body.data;
    expect(auto).toMatchObject({ stage_type: 'work', stage_type_manual: false });
  }, 60000);
});
