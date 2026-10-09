import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';

/** «Пульс команды» как командный центр (ТЗ-19): сводка правилами и действия с подтверждением. */
describe('Пульс команды (e2e)', () => {
  let app: INestApplication;
  let http$: any;
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
    await app.listen(0, '0.0.0.0');
    http$ = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    db = app.get(DbService);
  });
  afterAll(async () => app?.close());

  it('сводка, права, действия, балансировка, обратная связь', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Pulse', email: `pl_${uniq()}@t.test`, password: 'password123', fullName: 'Сергей' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const tenantId = String(owner.user.tenantId);
    const mk = async (name: string) => {
      const email = `plm_${uniq()}@t.test`;
      const u = (await http$.post('/api/users').set(O).send({ email, fullName: name, password: 'password123', role: 'member' }).expect(201)).body.data;
      const tok = (await http$.post('/api/auth/login').send({ email, password: 'password123' }).expect(201)).body.data.accessToken;
      return { id: String(u.id), H: H(tok) };
    };
    const gleb = await mk('Глеб');
    const anna = await mk('Анна');
    const project = (await http$.post('/api/projects').set(O).send({ name: 'Релиз' }).expect(201)).body.data;
    const board = (await http$.get(`/api/projects/${project.id}/board`).set(O).expect(200)).body.data;
    const col = board.columns[0].id;
    const task = async (title: string, o: Record<string, unknown> = {}) =>
      (await http$.post('/api/tasks').set(O).send({ projectId: project.id, columnId: col, title, ...o }).expect(201)).body.data;

    // Глеб перегружен: 8 задач, из них 3 просроченные
    const glebTasks: any[] = [];
    for (let i = 0; i < 8; i++) {
      glebTasks.push(await task(`Глеб ${i}`, { assigneeId: gleb.id, ...(i < 3 ? { deadlineAt: new Date(Date.now() - 2 * 86400_000).toISOString() } : {}) }));
    }
    const orphan = await task('Без исполнителя');
    // «давно»: задаче без исполнителя и одной из задач Глеба — неделя без движения
    await db.query(`UPDATE tasks SET created_at = now() - interval '7 days' WHERE id = ANY($1::bigint[])`, [[orphan.id, glebTasks[5].id]]);
    await db.query(`UPDATE task_activity SET created_at = now() - interval '7 days' WHERE task_id = ANY($1::bigint[])`, [[orphan.id, glebTasks[5].id]]);
    await db.query(`UPDATE users SET load_norm_points = 6 WHERE id = $1`, [gleb.id]);

    // сотруднику Пульс закрыт по умолчанию
    await http$.get('/api/radar/summary').set(gleb.H).expect(403);

    const s = (await http$.get('/api/radar/summary?tz=Europe/Moscow').set(O).expect(200)).body.data;
    expect(s.health.version).toBe('health_v1');
    expect(s.health.score).toBeGreaterThanOrEqual(0);
    expect(s.health.score).toBeLessThanOrEqual(100);
    expect(Object.keys(s.health.components).sort()).toEqual(['capacity', 'deadlines', 'delivery', 'flow', 'velocity']);
    expect(s.verdict.headline).toBeTruthy();
    const g = s.workload.find((w: any) => w.id === gleb.id);
    expect(g.pct).toBeGreaterThan(100);
    expect(g.band).toBe('overloaded');
    expect(s.bottlenecks.some((b: any) => b.taskId === String(orphan.id) && b.type === 'NO_ASSIGNEE')).toBe(true);
    expect(s.bottlenecks.some((b: any) => b.type === 'OVERDUE')).toBe(true);
    expect(s.decisions.some((d: any) => d.kind === 'no_assignee')).toBe(true);
    expect(s.velocity.label).toContain('закрытых задач');
    expect(s.can).toMatchObject({ act: true, rebalance: true, publish: true, editNorms: true });

    // переназначение: предпросмотр ничего не меняет, подтверждение — меняет; второй раз — нельзя
    const pv = (await http$.post('/api/radar/actions/preview').set(O).send({ type: 'TASK_REASSIGN', taskId: String(orphan.id), toUserId: anna.id }).expect(201)).body.data;
    expect(pv.preview).toContain('без исполнителя → Анна');
    expect((await db.one<{ a: string | null }>(`SELECT assignee_id::text AS a FROM tasks WHERE id=$1`, [orphan.id]))!.a).toBeNull();
    expect((await http$.post(`/api/radar/actions/${pv.id}/confirm`).set(O).expect(201)).body.data.status).toBe('completed');
    expect((await db.one<{ a: string }>(`SELECT assignee_id::text AS a FROM tasks WHERE id=$1`, [orphan.id]))!.a).toBe(anna.id);
    await http$.post(`/api/radar/actions/${pv.id}/confirm`).set(O).expect(409);

    // мягкий push: второй вопрос по той же задаче — только после паузы
    const nudge = (await http$.post('/api/radar/actions/preview').set(O).send({ type: 'TASK_NUDGE', taskId: String(glebTasks[0].id) }).expect(201)).body.data;
    await http$.post(`/api/radar/actions/${nudge.id}/confirm`).set(O).expect(201);
    await http$.post('/api/radar/actions/preview').set(O).send({ type: 'TASK_NUDGE', taskId: String(glebTasks[0].id) }).expect(409);

    // перенос срока
    const to = new Date(Date.now() + 5 * 86400_000).toISOString();
    const rs = (await http$.post('/api/radar/actions/preview').set(O).send({ type: 'TASK_RESCHEDULE', taskId: String(glebTasks[1].id), date: to }).expect(201)).body.data;
    await http$.post(`/api/radar/actions/${rs.id}/confirm`).set(O).expect(201);
    const dl = await db.one<{ d: Date }>(`SELECT deadline_at AS d FROM tasks WHERE id=$1`, [glebTasks[1].id]);
    expect(new Date(dl!.d).getTime()).toBeGreaterThan(Date.now());

    // отклонённое не выполнить
    const rj = (await http$.post('/api/radar/actions/preview').set(O).send({ type: 'TASK_FOCUS', taskId: String(glebTasks[2].id) }).expect(201)).body.data;
    await http$.post(`/api/radar/actions/${rj.id}/reject`).set(O).expect(201);
    await http$.post(`/api/radar/actions/${rj.id}/confirm`).set(O).expect(409);
    // чужое предложение не подтвердить
    await http$.post(`/api/radar/actions/${rs.id}/confirm`).set(anna.H).expect(404);

    // балансировка: предложение с «было → станет», подтверждение пакетом
    const rb = (await http$.post(`/api/radar/rebalance/${gleb.id}/preview`).set(O).expect(201)).body.data;
    expect(rb.before).toBeGreaterThan(100);
    expect(rb.moves.length).toBeGreaterThan(0);
    expect(rb.after).toBeLessThan(rb.before);
    await http$.post(`/api/radar/actions/${rb.id}/confirm`).set(O).expect(201);
    const moved = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM tasks WHERE id = ANY($1::bigint[]) AND assignee_id <> $2`, [rb.moves.map((m: any) => m.taskId), gleb.id]);
    expect(moved!.n).toBe(rb.moves.length);

    // «это не проблема» скрывает пункт; срок проекта и норма
    const target = s.bottlenecks.find((b: any) => b.type === 'OVERDUE');
    await http$.post('/api/radar/feedback').set(O).send({ kind: 'bottleneck', ref: target.taskId, reason: 'not_critical' }).expect(201);
    await http$.patch(`/api/radar/projects/${project.id}/target`).set(O).send({ date: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10) }).expect(200);
    await http$.patch(`/api/radar/people/${anna.id}/norm`).set(O).send({ norm: 20 }).expect(200);
    await http$.patch(`/api/radar/people/${anna.id}/norm`).set(O).send({ norm: 500 }).expect(400);
    const s2 = (await http$.get('/api/radar/summary').set(O).expect(200)).body.data;
    expect(s2.bottlenecks.some((b: any) => b.taskId === target.taskId)).toBe(false);
    expect(s2.allProjects.find((p: any) => p.id === String(project.id)).targetDate).toBeTruthy();

    // победа — только через предпросмотр и подтверждение
    const v = (await http$.post('/api/radar/actions/preview').set(O).send({ type: 'PUBLISH_NEWS', text: 'Команда закрыла релиз раньше срока!' }).expect(201)).body.data;
    await http$.post(`/api/radar/actions/${v.id}/confirm`).set(O).expect(201);
    const feed = (await http$.get('/api/feed').set(O).expect(200)).body.data;
    const items = Array.isArray(feed) ? feed : feed.items;
    expect(items.some((p: any) => String(p.body).includes('закрыла релиз'))).toBe(true);

    // журнал безопасности
    const audit = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM security_audit WHERE tenant_id=$1 AND event_type LIKE 'radar.%'`, [tenantId]);
    expect(audit!.n).toBeGreaterThan(3);

    // прежний адрес жив для выпущенных приложений
    await http$.get('/api/radar').set(O).expect(200);
  });
});
