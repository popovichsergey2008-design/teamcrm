import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { DbService } from '../src/database/db.service';

/** #4779: регистрация с сайта — первый шаг без имени и пространства, UTM, задача из демо, ошибки по-русски. */
describe('#4779 регистрация с сайта (e2e)', () => {
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
    await app.listen(0, '0.0.0.0');
    http = request(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    db = app.get(DbService);
  });
  afterAll(async () => app?.close());

  it('только почта и согласие → вход, знакомство после, метки сохранены, задача из демо в новом проекте', async () => {
    const email = `s_${uniq()}@t.test`;
    const reg = (await http.post('/api/auth/register').send({
      acceptPrivacy: true, email, password: 'Test-pass-2026', utm: { utm_source: 'site', utm_campaign: 'hero', evil: 'x' },
    }).expect(201)).body.data;
    const tok = reg.accessToken;
    const me = (await http.get('/api/me').set(H(tok)).expect(200)).body.data;
    expect(me.uiPrefs.setupNames).toBe(true);
    expect(reg.organizations[0].name).toBe('Моё пространство');
    const t = await db.one<{ signup_utm: Record<string, string> }>(`SELECT signup_utm FROM tenants WHERE id=$1`, [reg.organizations[0].tenantId]);
    expect(t?.signup_utm).toEqual({ utm_source: 'site', utm_campaign: 'hero' });

    const r = (await http.post('/api/onboarding/starter/demo-task').set(H(tok)).send({ title: 'Подготовить КП для клиента до пятницы' }).expect(201)).body.data;
    expect(r.projectId).toBeTruthy();
    const board = (await http.get(`/api/projects/${r.projectId}/board`).set(H(tok)).expect(200)).body.data;
    const titles = board.columns.flatMap((c: any) => c.tasks.map((x: any) => x.title));
    expect(titles).toContain('Подготовить КП для клиента до пятницы');
  });

  it('ошибка почты — по-русски, с примером', async () => {
    const res = await http.post('/api/auth/register').send({ acceptPrivacy: true, email: 'a@b', password: 'Test-pass-2026' }).expect(400);
    expect(res.body.error.message).toMatch(/Проверьте почту/);
  });
});
