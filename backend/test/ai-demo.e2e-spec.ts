import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';

/**
 * «ИИ-созвон за 30 секунд» (ТЗ-24): фраза → итоги → задачи на демо-доске. В тестах
 * ключа ИИ нет — демо идёт правилами, как у новой компании без ключа демо.
 */
describe('Демо ИИ-созвона в онбординге (e2e)', () => {
  let app: INestApplication;
  let http$: any;
  let db: DbService;
  const uniq = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  async function owner() {
    const o = (await http$.post('/api/auth/register')
      .send({ acceptPrivacy: true, tenantName: 'Демо', email: `demo_${uniq()}@t.test`, password: 'password123', fullName: 'Борис' }).expect(201)).body.data;
    return { O: H(o.accessToken), userId: String(o.user.id), tenantId: String(o.user.tenantId) };
  }
  async function waitReview(O: any, demoId: string) {
    let v: any;
    for (let i = 0; i < 40; i++) {
      v = (await http$.get(`/api/onboarding/ai-call/${demoId}`).set(O).expect(200)).body.data;
      if (!['started', 'processing'].includes(v.status)) return v;
      await sleep(150);
    }
    return v;
  }

  it('фраза → две задачи на демо-доске, без дублей; проект не закрывает шаг «первый проект», пока не рабочий', async () => {
    const { O, userId } = await owner();
    const start = (await http$.post('/api/onboarding/ai-call/start').set(O).send({ entryPoint: 'welcome' }).expect(201)).body.data;
    expect(start.mode).toBe('rules');

    await http$.post(`/api/onboarding/ai-call/${start.demoId}/finish`).set(O)
      .field('text', 'Нужно обновить логотип к среде и созвониться с маркетологом').expect(201);
    const v = await waitReview(O, start.demoId);
    expect(v.status).toBe('review');
    expect(v.transcript).toMatch(/логотип/);
    expect(v.summary).toMatch(/два действия/);
    expect(v.drafts.map((d: any) => d.title)).toEqual(['Обновить логотип', 'Созвониться с маркетологом']);
    expect(v.drafts[0].deadlineAt).toBeTruthy();
    expect(v.drafts[1].kind).toBe('meeting');
    expect(v.drafts.every((d: any) => d.assigneeId === userId)).toBe(true);

    // двойное «Создать» — задач всё равно две
    const items = v.drafts.map((d: any) => ({ draftId: String(d.id) }));
    const [a, b] = await Promise.all([0, 1].map(() => http$.post(`/api/onboarding/ai-call/${start.demoId}/create-tasks`).set(O).send({ items })));
    expect([a.status, b.status]).toEqual([201, 201]);
    const projectId = a.body.data.projectId;
    const board = (await http$.get(`/api/projects/${projectId}/board`).set(O).expect(200)).body.data;
    expect(board.project.name).toBe('Мой первый AI-проект');
    expect(board.columns.flatMap((c: any) => c.tasks).map((t: any) => t.title).sort()).toEqual(['Обновить логотип', 'Созвониться с маркетологом']);

    let ob = (await http$.get('/api/onboarding').set(O).expect(200)).body.data;
    expect(ob.steps.find((s: any) => s.key === 'ai_demo').done).toBe(true);
    expect(ob.steps.find((s: any) => s.key === 'project').done).toBe(false); // демо — не настоящий проект

    await http$.post(`/api/onboarding/ai-call/projects/${projectId}/convert`).set(O).send({ name: 'Ребрендинг' }).expect(201);
    ob = (await http$.get('/api/onboarding').set(O).expect(200)).body.data;
    expect(ob.steps.find((s: any) => s.key === 'project').done).toBe(true);
    await http$.post(`/api/onboarding/ai-call/projects/${projectId}/convert`).set(O).send({}).expect(404); // уже рабочий

    await http$.post(`/api/onboarding/ai-call/${start.demoId}/complete`).set(O).expect(201);
    expect((await http$.get('/api/onboarding/ai-call').set(O).expect(200)).body.data.last.status).toBe('completed');
  });

  it('несуществующего «дизайнера» не выдумываем; «Пропустить» убирает приглашение; лимит попыток', async () => {
    const { O, tenantId, userId } = await owner();
    const s = (await http$.post('/api/onboarding/ai-call/start').set(O).send({}).expect(201)).body.data;
    await http$.post(`/api/onboarding/ai-call/${s.demoId}/finish`).set(O).field('text', 'Пусть дизайнер обновит логотип').expect(201);
    const v = await waitReview(O, s.demoId);
    expect(v.drafts[0]).toMatchObject({ assigneeHint: 'дизайнер', assigneeId: null });
    // пустая фраза — «скажите хотя бы одну»
    await http$.post(`/api/onboarding/ai-call/${s.demoId}/finish`).set(O).field('text', '').expect(400);

    await http$.post('/api/onboarding/ai-call/skip').set(O).send({}).expect(201);
    const ob = (await http$.get('/api/onboarding').set(O).expect(200)).body.data;
    expect(ob.steps.find((x: any) => x.key === 'ai_demo').skipped).toBe(true);

    // три попытки в сутки
    await db.query(`DELETE FROM onboarding_ai_demos WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
    for (let i = 0; i < 3; i++) await http$.post('/api/onboarding/ai-call/start').set(O).send({}).expect(201);
    await http$.post('/api/onboarding/ai-call/start').set(O).send({}).expect(409);
  });
});
