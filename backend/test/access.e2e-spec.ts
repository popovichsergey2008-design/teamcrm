import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';

/**
 * Закрытые проекты не утекают (ТЗ-21, этап 0): общий поиск, встречи, скачивание файлов,
 * кандидаты на объединение. Раньше всё это фильтровалось только по компании.
 */
describe('Доступ к закрытым проектам (e2e)', () => {
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
  afterAll(async () => { await app?.close(); });

  it('сотрудник вне закрытого проекта не находит, не открывает и не скачивает его данные', async () => {
    const owner = (await http$.post('/api/auth/register')
      .send({ tenantName: 'Доступ', email: `acc_${uniq()}@t.test`, password: 'password123', fullName: 'Владелец' }).expect(201)).body.data;
    const O = H(owner.accessToken);
    const mk = async (name: string) => {
      const email = `accm_${uniq()}@t.test`;
      const u = (await http$.post('/api/users').set(O).send({ email, fullName: name, password: 'password123', role: 'member' }).expect(201)).body.data;
      const tok = (await http$.post('/api/auth/login').send({ email, password: 'password123' }).expect(201)).body.data.accessToken;
      return { id: String(u.id), H: H(tok) };
    };
    const gleb = await mk('Глеб');
    const anna = await mk('Анна');

    const secret = (await http$.post('/api/projects').set(O).send({ name: 'Тайный проект' }).expect(201)).body.data;
    await db.query(`UPDATE projects SET visibility = 'members' WHERE id = $1`, [secret.id]);
    await db.query(`INSERT INTO project_members (tenant_id, project_id, user_id) VALUES ($1,$2,$3)`, [owner.user.tenantId, secret.id, anna.id]);
    const board = (await http$.get(`/api/projects/${secret.id}/board`).set(O).expect(200)).body.data;
    const task = (await http$.post('/api/tasks').set(O).send({ projectId: secret.id, columnId: board.columns[0].id, title: 'Смета для банка тайная' }).expect(201)).body.data;

    // общий поиск
    const sG = (await http$.get('/api/search?q=Смета').set(gleb.H).expect(200)).body.data;
    expect(sG.tasks.map((t: any) => String(t.id))).not.toContain(String(task.id));
    expect(sG.projects.map((p: any) => String(p.id))).not.toContain(String(secret.id));
    const sA = (await http$.get('/api/search?q=Смета').set(anna.H).expect(200)).body.data;
    expect(sA.tasks.map((t: any) => String(t.id))).toContain(String(task.id));

    // кандидаты на объединение и «возможный дубль» при создании
    const dup = (await http$.get('/api/tasks/duplicates').query({ title: 'Смета для банка тайная' }).set(gleb.H).expect(200)).body.data;
    expect(dup.items.map((t: any) => String(t.id))).not.toContain(String(task.id));

    // встреча закрытого проекта
    const [m] = await db.many<{ id: string }>(
      `INSERT INTO meetings (tenant_id, title, source, project_id, created_by, status) VALUES ($1, 'Совещание тайное', 'upload', $2, $3, 'done') RETURNING id`,
      [owner.user.tenantId, secret.id, owner.user.id],
    );
    expect((await http$.get('/api/meetings').set(gleb.H).expect(200)).body.data.map((x: any) => String(x.id))).not.toContain(String(m.id));
    await http$.get(`/api/meetings/${m.id}`).set(gleb.H).expect(404);
    await http$.get(`/api/meetings/${m.id}`).set(anna.H).expect(200);

    // вложение задачи закрытого проекта — по номеру
    const fileId = String((await http$.post(`/api/tasks/${task.id}/attachments`).set(O)
      .attach('file', Buffer.from('секрет'), 'smeta.txt').expect(201)).body.data.fileId);
    await http$.get(`/api/files/${fileId}`).set(gleb.H).expect(404);
    await http$.get(`/api/files/${fileId}`).set(anna.H).expect(200);
  });
});
