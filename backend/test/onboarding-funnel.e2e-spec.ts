import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/http/all-exceptions.filter';
import { ResponseInterceptor } from '../src/common/http/response.interceptor';
import { RedisIoAdapter } from '../src/common/auth/redis-io.adapter';
import { PlatformService } from '../src/modules/platform/platform.service';

/**
 * Воронка онбординга (ТЗ-11, разд. 56-57).
 *
 * Два обещания. Первое: это кабинет разработчика продукта, и клиенту он не виден — даже
 * владельцу своей организации. Второе: воронка считается ПО ФАКТАМ, а не по отметкам, и
 * значит, срабатывает на организации, которая просто работает, ничего специально не
 * нажимая, и задним числом — на заведённых до появления этого экрана.
 */
describe('воронка онбординга (e2e)', () => {
  let app: INestApplication;
  let http: any;
  let platform: PlatformService;
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
    platform = app.get(PlatformService);
  });
  afterAll(async () => { await app?.close(); });

  const owner = async (tag: string) => {
    const data = (await http.post('/api/auth/register')
      .send({ tenantName: tag, email: `${tag}_${uniq()}@t.test`, password: 'password123', fullName: 'Ольга Владелец' })
      .expect(201)).body.data;
    return { data, H: H(data.accessToken) };
  };

  it('считается по фактам: организация, просто сделавшая задачу, дошла до конца воронки', async () => {
    const vendor = await owner('FNV');
    const client = await owner('FNC');

    // Клиент ничего не «нажимает по онбордингу»: делает проект и задачу, как в жизни.
    const project = (await http.post('/api/projects').set(client.H)
      .send({ name: 'Первый проект' }).expect(201)).body.data;
    const board = (await http.get(`/api/projects/${project.id}/board`).set(client.H).expect(200)).body.data;
    await http.post('/api/tasks').set(client.H)
      .send({ projectId: project.id, columnId: board.columns[0].id, title: 'Первая задача' }).expect(201);

    await platform.declarePlatform(String(vendor.data.user.tenantId), String(vendor.data.user.id));
    try {
      const r = (await http.get('/api/platform/funnel').set(vendor.H).expect(200)).body.data;

      const row = r.tenants.find((t: any) => String(t.tenantId) === String(client.data.user.tenantId));
      expect(row).toBeTruthy();
      expect(row.steps.workspace).toBeTruthy();
      expect(row.steps.project).toBeTruthy();
      expect(row.steps.task).toBeTruthy();
      // Отделов не заводили — и воронка это показывает, а не домысливает.
      expect(row.steps.department).toBeNull();
      // Время до первой задачи измерено: это главная метрика ТЗ.
      expect(typeof row.durations.toTask).toBe('number');
      expect(row.durations.toValue).toBe(row.durations.toTask);

      // Свод не врёт делением на ноль и знает, сколько всего организаций.
      expect(r.summary.tenants).toBeGreaterThan(0);
      const step = (k: string) => r.summary.steps.find((s: any) => s.key === k);
      expect(step('workspace').count).toBe(r.summary.tenants);
      expect(step('task').count).toBeGreaterThan(0);
      expect(step('task').share).toBeLessThanOrEqual(1);

      // Организация-вендор в продуктовой воронке не участвует: это мы сами.
      expect(r.tenants.some((t: any) => String(t.tenantId) === String(vendor.data.user.tenantId))).toBe(false);

      // Клиенту консоль не видна — ни своя воронка, ни чужая.
      await http.get('/api/platform/funnel').set(client.H).expect(403);
    } finally {
      await platform.clearPlatform();
    }
  }, 90000);

  it('без техотдела ручка не отвечает никому: это не клиентский отчёт', async () => {
    const me = await owner('FNX');
    await http.get('/api/platform/funnel').set(me.H).expect(403);
    await http.get('/api/platform/funnel').expect(401);
  }, 60000);
});
